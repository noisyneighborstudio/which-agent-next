import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRun, approveRun, initializeRun, readRun, withRun } from '../dist/loop/state.js';
import { seedPlan, DEFAULT_SETTINGS } from '../dist/loop/protocol.js';
import { publicationReady, publishProgress, serveDashboard } from '../dist/loop/progress.js';

function fixture(t, { approved = true, permission = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wan-progress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = seedPlan('Ship the whole goal', 600_000);
  plan.permissions = permission ? ['github:pr'] : [];
  const state = Object.assign(createRun({ id: 'publication-test', cwd: dir, plan }), {
    jobs: [], questions: [], answers: {}, failedProviders: {}, settings: DEFAULT_SETTINGS,
    git: { base: 'base', branch: 'wan/test' }, candidate: 'a'.repeat(40),
  });
  if (approved) approveRun(state);
  initializeRun(dir, state);
  return dir;
}

function remote(dir, options = {}) {
  const calls = [], payloads = new Map();
  let pr, comments = [], crash = options.crash;
  const ok = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const runCommand = async (bin, args) => {
    calls.push([bin, ...args]);
    // A network boundary must allow state transactions, proving no journal lock is held.
    withRun(dir, state => { state.supervisor.heartbeat = Date.now(); });
    await new Promise(resolve => setTimeout(resolve, 2));
    if (bin === 'git') {
      if (args.includes('config')) return ok(args.at(-1) === 'user.name' ? 'dougbot-agent' : '123+dougbot-agent@users.noreply.github.com');
      assert(args.includes('push'));
      assert(args.at(-1).startsWith(`${readRun(dir).candidate}:refs/heads/`));
      if (options.pushFail) return { code: 1, stdout: '', stderr: 'push failed' };
      return ok('');
    }
    assert.equal(bin, 'gh');
    if (args[0] === 'bot') return ok('');
    if (args[0] === 'api' && args[1] === 'user') return ok(options.identity ?? 'dougbot-agent');
    if (args[0] === 'repo') return ok('owner/repo');
    if (args[0] === 'pr' && args[1] === 'list') return ok(pr ? [pr] : []);
    const payloadFlag = args.includes('--body-file') ? '--body-file' : '--input';
    if (args.includes(payloadFlag)) {
      const path = args[args.indexOf(payloadFlag) + 1];
      assert(!payloads.has(path), 'each write has a unique immutable payload');
      assert.equal(statSync(path).mode & 0o777, 0o600);
      payloads.set(path, readFileSync(path, 'utf8'));
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      assert(!pr, 'duplicate PR creation');
      pr = { number: 17, url: 'https://github.com/owner/repo/pull/17' };
      if (crash === 'pr') { crash = undefined; throw new Error('lost PR response'); }
      return ok(pr.url);
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (options.changeCandidate) withRun(dir, state => { state.candidate = 'b'.repeat(40); });
      return ok({ headRefOid: options.head ?? 'a'.repeat(40) });
    }
    if (args[0] === 'api' && !args.includes('--method')) {
      assert(args.includes('--paginate'));
      return ok([[], comments]); // Marker discovery must include later pages.
    }
    if (args[0] === 'api') {
      const method = args[args.indexOf('--method') + 1];
      const body = JSON.parse(readFileSync(args[args.indexOf('--input') + 1], 'utf8')).body;
      if (method === 'POST') {
        assert.equal(comments.length, 0, 'duplicate comment creation');
        comments.push({ id: 42, body, user: { login: 'dougbot-agent' } });
      } else { assert.equal(method, 'PATCH'); comments[0].body = body; }
      if (crash === 'comment') { crash = undefined; throw new Error('lost comment response'); }
      return ok({ id: 42 });
    }
    assert.fail(`Unexpected command: ${bin} ${args.join(' ')}`);
  };
  return { runCommand, calls, payloads, count: (...prefix) => calls.filter(c => prefix.every((x, i) => c[i] === x)).length };
}

const writes = calls => calls.filter(c => c.includes('push') || c.includes('create') || c.includes('--method'));

test('concurrent publishers serialize, reread state, and record confirmed candidate', async t => {
  const dir = fixture(t), api = remote(dir);
  assert.equal(publicationReady(readRun(dir)), false);
  await Promise.all([publishProgress(dir, api), publishProgress(dir, api), publishProgress(dir, api)]);
  assert.equal(api.count('gh', 'pr', 'create'), 1);
  assert.equal(api.calls.filter(c => c.includes('POST')).length, 1);
  assert.equal(api.calls.filter(c => c.includes('push')).length, 1);
  const state = readRun(dir);
  assert.equal(state.pr.publishedCandidate, state.candidate);
  assert.equal(publicationReady(state), true);
  assert.equal(state.publicationLease, undefined);
  const activation = api.calls.findIndex(c => c[0] === 'gh' && c[1] === 'bot');
  const identity = api.calls.findIndex(c => c[0] === 'gh' && c[2] === 'user');
  const firstWrite = api.calls.findIndex(c => writes([c]).length);
  assert(activation < identity && identity < firstWrite);
  if (process.platform === 'darwin') assert(api.calls.filter(c => c[0] === 'git').every(c => c[1] === 'dougbot'));
});

for (const crash of ['pr', 'comment']) test(`retry recovers ${crash} created before local persistence`, async t => {
  const dir = fixture(t), api = remote(dir, { crash });
  await assert.rejects(publishProgress(dir, api), /lost .* response/);
  assert.equal(publicationReady(readRun(dir)), false);
  await publishProgress(dir, api);
  assert.equal(api.count('gh', 'pr', 'create'), 1);
  assert.equal(api.calls.filter(c => c.includes('POST')).length, 1);
  assert.equal(api.calls.filter(c => c.includes('PATCH')).length, 0);
  assert.equal(publicationReady(readRun(dir)), true);
});

test('timestamp and heartbeat changes cause no remote calls; real progress edits the same comment', async t => {
  const dir = fixture(t), api = remote(dir);
  await publishProgress(dir, api);
  const count = api.calls.length;
  withRun(dir, state => {
    state.supervisor.lastInspection = Date.now();
    state.supervisor.heartbeat = Date.now();
    state.host = { pid: process.pid, signature: 'private', heartbeat: Date.now() };
  });
  await publishProgress(dir, api);
  assert.equal(api.calls.length, count);
  withRun(dir, state => { state.plan.tasks[0].summary = 'Implemented delivery'; });
  await publishProgress(dir, api);
  assert.equal(api.calls.filter(c => c.includes('POST')).length, 1);
  assert.equal(api.calls.filter(c => c.includes('PATCH')).length, 1);
});

test('unapproved or unauthorized publication never invokes tools', async t => {
  for (const config of [{ approved: false }, { permission: false }]) {
    const dir = fixture(t, config);
    await publishProgress(dir, { runCommand: async () => assert.fail('external tool invoked') });
    assert.equal(publicationReady(readRun(dir)), true);
  }
});

test('approved permission remains an obligation without a candidate or code branch', async t => {
  const dir = fixture(t);
  withRun(dir, state => { delete state.candidate; });
  assert.equal(publicationReady(readRun(dir)), false);
  await assert.rejects(publishProgress(dir, { runCommand: async () => assert.fail('external call') }), /pinned candidate/);
});

test('wrong bot identity prevents every write', async t => {
  const dir = fixture(t), api = remote(dir, { identity: 'personal-user' });
  await assert.rejects(publishProgress(dir, api), /expected.*dougbot-agent/);
  assert.equal(writes(api.calls).length, 0);
  assert.equal(publicationReady(readRun(dir)), false);
});

for (const config of [{ head: 'wrong-head' }, { changeCandidate: true }, { pushFail: true }]) test(`publication failure cannot record success: ${JSON.stringify(config)}`, async t => {
  const dir = fixture(t), api = remote(dir, config);
  await assert.rejects(publishProgress(dir, api), /head does not match|Candidate changed|push failed/);
  assert.equal(publicationReady(readRun(dir)), false);
  assert.equal(readRun(dir).pr?.publishedCandidate, undefined);
});

test('configured remote bot tools are used without the macOS alias', async t => {
  const dir = fixture(t), api = remote(dir);
  await publishProgress(dir, { gitTools: { run: api.runCommand, gitBot: ['git'], gh: ['gh'] } });
  assert(api.calls.filter(c => c[0] === 'git').every(c => !c.includes('dougbot')));
  assert.equal(publicationReady(readRun(dir)), true);
});

test('dead process publication lease is recovered durably', async t => {
  const dir = fixture(t), api = remote(dir);
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(child.status, 0);
  withRun(dir, state => { state.publicationLease = { token: 'dead-owner', pid: child.pid, acquiredAt: Date.now() }; });
  await publishProgress(dir, api);
  assert.equal(publicationReady(readRun(dir)), true);
  assert.equal(readRun(dir).publicationLease, undefined);
});

function http(port, path = '/', method = 'GET', host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Host: host } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}

test('dashboard is loopback, read-only, escapes text and excludes raw logs and private metadata', async t => {
  const dir = fixture(t);
  withRun(dir, state => {
    state.plan.tasks[0].summary = '<script>alert("oops")</script>';
    state.answers = { credential: 'SECRET_CREDENTIAL' };
    state.events.push({ at: Date.now(), type: 'log', detail: 'SECRET_LOG' });
    state.jobs = [{ kind: 'test', id: 'job1', command: 'SECRET_COMMAND', candidate: state.candidate, pid: process.pid, startedAt: Date.now(), directory: dir }];
  });
  writeFileSync(join(dir, 'output.log'), 'SECRET_LOG');
  const server = await serveDashboard(dir);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  const page = await http(address.port);
  assert.equal(page.status, 200);
  assert(page.body.includes('&lt;script&gt;'));
  assert(!page.body.includes('<script>'));
  assert(page.body.includes('Acceptance evidence'));
  const json = await http(address.port, '/state.json');
  for (const response of [page, json]) {
    assert(!/SECRET_|output\.log/.test(response.body));
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal((await http(address.port, '/', 'HEAD')).body, '');
  assert.equal((await http(address.port, '/', 'POST')).status, 405);
  for (const host of ['evil.example', 'localhost:80:evil', '127.0.0.1.evil']) {
    assert.equal((await http(address.port, '/', 'GET', host)).status, 403);
  }
  for (const path of ['/../output.log', '/%2e%2e/output.log', '/output.log']) {
    assert.equal((await http(address.port, path)).status, 404);
  }
});
