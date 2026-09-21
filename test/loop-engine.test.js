import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, approveRun, initializeRun, extendBudget, readRun, reserveInvocation, finishInvocation } from '../dist/loop/state.js';
import { shellQuote } from '../dist/util.js';
import { DEFAULT_SETTINGS } from '../dist/loop/protocol.js';
import { controller, stateOf, mutate } from '../dist/loop/engine.js';
import { copyArtifacts, integrateArtifacts } from '../dist/loop/artifacts.js';
import { serveDashboard, renderDashboard } from '../dist/loop/progress.js';
import { parseLoopArgs } from '../dist/loop/cli.js';
import { startJob, collectJob } from '../dist/loop/jobs.js';
import { request } from 'node:http';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wan-engine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'deliverables'), dir = join(root, 'run'); mkdirSync(cwd);
  const plan = {
    goal: 'Deliver both a.txt and b.txt, each containing its own letter.', budgetMs: 30000,
    criteria: ['a', 'b'].map(id => ({ id, description: `${id}.txt contains ${id}`, verification: 'Inspect exact file content' })),
    deliverables: ['a.txt', 'b.txt'], permissions: [], verificationCommands: [],
    tasks: ['a', 'b'].map(id => ({ id, title: id, instructions: `Write ${id}.txt`, ownership: [`${id}.txt`], criteria: [id], dependsOn: [], status: 'pending', attempts: 0, failures: 0 })),
    ...overrides,
  };
  const state = { ...createRun({ cwd, kind: 'artifact', plan }), settings: { ...DEFAULT_SETTINGS, invocationMs: 1000 }, jobs: [], questions: [], answers: {}, failedProviders: {} };
  approveRun(state); initializeRun(dir, state);
  return { root, dir, cwd };
}

function simulatedAgents(dir, options = {}) {
  let activeWorkers = 0, peakWorkers = 0, calls = 0;
  const roles = [], events = [], recaps = [];
  const runtime = {
    async selectProvider(options) {
      if (options?.exclude?.includes('fake')) return { provider: { id: 'fallback', cli: 'codex', command: 'unused' }, reason: 'test fallback' };
      return { provider: { id: 'fake', cli: 'codex', command: 'unused' }, reason: 'simulated provider' };
    },
    async invokeAgent(req) {
      if (req.role === 'recap') {
        recaps.push(req.prompt);
        return { exitCode: 0, signal: null, timedOut: false, elapsedMs: 5, text: `WAN_RESULT ${JSON.stringify({ recap: `recap ${recaps.length}` })}` };
      }
      roles.push(req.role); calls++;
      let report;
      if (req.role === 'worker') {
        activeWorkers++; peakWorkers = Math.max(peakWorkers, activeWorkers);
        await new Promise(resolve => setTimeout(resolve, 15));
        const task = JSON.parse(/Assignment: (.+)\. Only modify owned paths:/.exec(req.prompt)[1]);
        if (options.worker) report = await options.worker(req, task, calls);
        else { writeFileSync(join(req.cwd, `${task.id}.txt`), task.id); report = { status: 'implemented', summary: `Wrote ${task.id}`, evidence: [`${task.id}.txt`] }; }
        activeWorkers--;
      } else if (req.role === 'coordinator') report = { decision: 'integrate', summary: 'Inspected actual file content.' };
      else if (req.role === 'verifier') {
        const state = stateOf(dir);
        const criteria = req.prompt.includes('This is pre-action verification.') ? state.plan.criteria.filter(c => c.phase !== 'outcome') : state.plan.criteria;
        report = { candidate: state.candidate, summary: 'Checked both deliverables.', criteria: criteria.map(c => ({ id: c.id, passed: existsSync(join(req.cwd, `${c.id}.txt`)) && readFileSync(join(req.cwd, `${c.id}.txt`), 'utf8') === c.id, detail: `Read ${c.id}.txt from the pinned workspace.` })) };
        if (options.verifier) report = options.verifier(req, report);
      } else if (req.role === 'supervisor') {
        const state = stateOf(dir);
        const criteria = req.prompt.includes('deliverable-phase') ? state.plan.criteria.filter(c => c.phase !== 'outcome') : state.plan.criteria;
        const ready = state.plan.tasks.every(t => t.status === 'integrated') && criteria.every(c => state.evidence.some(e => e.candidate === state.candidate && e.criterionId === c.id && e.passed));
        report = { decision: ready ? 'ready' : state.plan.tasks.some(t => t.failures >= 3) ? 'pause' : 'continue', candidate: state.candidate, summary: 'Inspected remaining obligations and evidence.', findings: [] };
      } else throw new Error(`Unexpected role ${req.role}`);
      events.push({ role: req.role, report });
      return { exitCode: 0, signal: null, timedOut: false, elapsedMs: 20, text: `WAN_RESULT ${JSON.stringify(report)}` };
    },
  };
  return { runtime, roles, events, recaps, peakWorkers: () => peakWorkers };
}

test('whole-goal artifact run integrates two parallel workers and requires verifier then supervisor', async t => {
  const { dir, cwd } = fixture(t), agents = simulatedAgents(dir);
  await controller(dir, agents.runtime);
  const state = stateOf(dir);
  assert.equal(state.status, 'READY_FOR_REVIEW');
  assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'a');
  assert.equal(readFileSync(join(cwd, 'b.txt'), 'utf8'), 'b');
  assert.equal(agents.peakWorkers(), 2);
  assert.deepEqual(agents.roles.slice(-2), ['verifier', 'supervisor']);
  assert.ok(state.budget.usedMs > 0);
  assert.equal(state.evidence.filter(e => e.passed).length, 2);
  assert.ok(existsSync(join(dir, 'final-evidence.json')));
});

test('each turn tails the tape with a recap that is charged but uses no allocation slot', async t => {
  const { dir } = fixture(t), agents = simulatedAgents(dir);
  const log = t.mock.method(console, 'log', () => {});
  await controller(dir, agents.runtime);
  const state = stateOf(dir);
  const tape = log.mock.calls.map(c => String(c.arguments[0]));
  assert.equal(agents.recaps.length, agents.roles.length);
  assert.equal(tape.length, agents.recaps.length);
  assert.ok(tape.every(line => /^\[\d\d:\d\d:\d\d\] \w+( \w+)? \(fake\) — recap \d+$/.test(line)));
  assert.match(tape.at(-1), /^\[[\d:]+\] supervisor \(fake\) — recap/);
  const recaps = state.invocations.filter(i => i.role === 'recap');
  assert.equal(recaps.length, agents.recaps.length);
  assert.ok(recaps.every(i => i.reservedMs <= 60_000 && i.chargedMs !== undefined));
  assert.equal(state.allocation.invocations, state.invocations.length - recaps.length);
});

test('an independent supervisor holds a checkpoint without repeatedly inventing worker attempts', async t => {
  const { dir } = fixture(t), agents = simulatedAgents(dir);
  const select = agents.runtime.selectProvider;
  let scheduled = false, attemptsDuringAssessment;
  agents.runtime.selectProvider = async options => {
    if (!scheduled) {
      scheduled = true;
      mutate(dir, s => reserveInvocation(s, { id: 'monitor-assessment', role: 'supervisor', provider: 'monitor-fixture', limitMs: 2000 }));
      setTimeout(() => {
        attemptsDuringAssessment = stateOf(dir).plan.tasks.map(t => t.attempts);
        mutate(dir, s => finishInvocation(s, 'monitor-assessment', 'success'));
      }, 1200);
    }
    return select(options);
  };
  await controller(dir, agents.runtime);
  assert.ok(attemptsDuringAssessment.every(attempts => attempts <= 1), `Attempts grew while blocked by supervision: ${attemptsDuringAssessment}`);
  assert.equal(stateOf(dir).status, 'READY_FOR_REVIEW');
});

test('a worker claiming completion of a half goal cannot finish; verification sends it back for repair', async t => {
  const { dir } = fixture(t);
  let skipped = false;
  const agents = simulatedAgents(dir, { worker(req, task) {
    if (task.id === 'b' && !skipped) skipped = true;
    else writeFileSync(join(req.cwd, `${task.id}.txt`), task.id);
    return { status: 'implemented', summary: 'Worker claims the assignment is done.', evidence: [] };
  } });
  await controller(dir, agents.runtime);
  const state = stateOf(dir);
  assert.equal(state.status, 'READY_FOR_REVIEW');
  assert.ok(state.events.some(e => e.type === 'verification-failed'));
  assert.ok(state.plan.tasks.find(t => t.id === 'b').attempts >= 2);
  assert.equal(agents.roles.filter(role => role === 'verifier').length, 2);
});

test('three identical failures trigger diagnosis and durable pause, not false completion', async t => {
  const { dir } = fixture(t);
  const agents = simulatedAgents(dir, { worker() { return { status: 'blocked', summary: 'Required input is unavailable.', evidence: [] }; } });
  await controller(dir, agents.runtime);
  const state = stateOf(dir);
  assert.equal(state.status, 'PAUSED');
  assert.ok(state.plan.tasks.every(t => t.status !== 'integrated'));
  assert.ok(agents.roles.includes('supervisor'));
  assert.ok(state.events.some(e => e.type === 'stall'));
});

test('allocation renewal preserves cumulative execution charges', async t => {
  const { dir } = fixture(t);
  mutate(dir, s => { s.allocation.maxInvocations = 6; });
  const agents = simulatedAgents(dir);
  await controller(dir, agents.runtime);
  const state = stateOf(dir);
  assert.equal(state.status, 'READY_FOR_REVIEW');
  assert.ok(state.allocation.number > 1);
  assert.equal(state.budget.usedMs, state.invocations.reduce((n, i) => n + i.chargedMs, 0));
  assert.ok(state.events.some(e => e.type === 'allocation_renewed'));
});

test('known quota exhaustion waits without spending agent budget', async t => {
  const { dir } = fixture(t);
  let selections = 0;
  const agents = simulatedAgents(dir);
  const normal = agents.runtime.selectProvider;
  agents.runtime.selectProvider = async options => {
    selections++;
    if (selections <= 2) return { reason: 'known exhausted quota', retryAt: Date.now() + 30 };
    return normal(options);
  };
  await controller(dir, agents.runtime);
  const state = stateOf(dir);
  assert.equal(state.status, 'READY_FOR_REVIEW');
  assert.ok(state.events.some(e => e.type === 'capacity'));
  assert.equal(state.invocations.length, agents.roles.length + agents.recaps.length);
});

test('unknown capacity pauses without a spend or imaginary retry deadline', async t => {
  const { dir } = fixture(t);
  await controller(dir, { selectProvider: async () => ({ reason: 'No known reset or authenticated provider.' }) });
  const state = stateOf(dir);
  assert.equal(state.status, 'PAUSED');
  assert.equal(state.retryAt, undefined);
  assert.equal(state.budget.usedMs, 0);
});

test('verifier mutation of a pinned candidate is rejected', async t => {
  const { dir } = fixture(t);
  const agents = simulatedAgents(dir, { verifier(req, report) { writeFileSync(join(req.cwd, 'a.txt'), 'changed by verifier'); return report; } });
  await controller(dir, agents.runtime);
  assert.equal(stateOf(dir).status, 'PAUSED');
  assert.ok(stateOf(dir).events.some(e => e.type === 'verification-rejected'));
});

test('artifact integration rejects a conflict before applying any changed files', t => {
  const root = mkdtempSync(join(tmpdir(), 'wan-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'target'), worker = join(root, 'worker'); mkdirSync(target);
  writeFileSync(join(target, 'a.txt'), 'base'); writeFileSync(join(target, 'b.txt'), 'base');
  const base = copyArtifacts(target, worker);
  writeFileSync(join(worker, 'a.txt'), 'worker'); writeFileSync(join(worker, 'b.txt'), 'worker');
  writeFileSync(join(target, 'b.txt'), 'concurrent change');
  assert.throws(() => integrateArtifacts(worker, target, base, ['**']), /conflict/);
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'base');
});

test('owned verification job survives its caller and records a real failure', async t => {
  const { dir, cwd } = fixture(t);
  const job = startJob(dir, cwd, 'echo verification-output; exit 7', 'candidate-one');
  let result = job;
  for (let n = 0; n < 100 && !result.endedAt; n++) { await new Promise(resolve => setTimeout(resolve, 20)); result = collectJob(job); }
  assert.equal(result.exitCode, 7);
  assert.match(readFileSync(join(job.directory, 'output.log'), 'utf8'), /verification-output/);
});

test('dashboard binds to loopback, escapes task data, and rejects hostile Host and writes', async t => {
  const { dir } = fixture(t, { goal: '<script>alert(1)</script>' });
  assert.ok(!renderDashboard(stateOf(dir)).includes('<script>'));
  const server = await serveDashboard(dir);
  t.after(() => server.close());
  const url = stateOf(dir).dashboard.url;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  const hostile = await new Promise((resolve, reject) => { const req = request(url, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(hostile, 403);
  assert.equal((await fetch(url + 'state.json')).status, 200);
});

test('CLI rejects unbounded or malformed budgets and worker counts', () => {
  for (const budget of ['Infinityh', 'NaNm', '-1h', '0h']) assert.throws(() => parseLoopArgs(['start', 'goal', '--budget', budget]));
  assert.throws(() => parseLoopArgs(['start', 'goal', '--concurrency', '2.5']));
  assert.equal(parseLoopArgs(['goal', '--budget', '2h']).budget, 7200000);
});

test('verification commands cannot repair artifacts and certify the unchanged original candidate', async t => {
  const { dir } = fixture(t, { verificationCommands: ['echo forged > a.txt'] });
  const agents = simulatedAgents(dir);
  await assert.rejects(controller(dir, agents.runtime), /changed deliverables/);
  assert.equal(stateOf(dir).status, 'PAUSED');
  assert.ok(!agents.roles.includes('verifier'));
});

test('parallel scheduling preserves verification capacity atomically', async t => {
  const { dir } = fixture(t, { budgetMs: 1000 });
  const agents = simulatedAgents(dir), invoke = agents.runtime.invokeAgent;
  agents.runtime.invokeAgent = async req => {
    if (['worker', 'coordinator'].includes(req.role)) {
      const state = stateOf(dir);
      const reserved = state.invocations.filter(i => !i.endedAt).reduce((n, i) => n + i.reservedMs, 0);
      assert.ok(state.budget.limitMs - state.budget.usedMs - reserved >= 200);
    }
    return invoke(req);
  };
  await controller(dir, agents.runtime);
  assert.equal(stateOf(dir).status, 'READY_FOR_REVIEW');
});

test('authorized external outcome executes only after verification and gets fresh post-action review', async t => {
  const { dir, root } = fixture(t);
  // Supply a new draft with explicit action authority before approval.
  const existing = stateOf(dir), output = join(root, 'published.txt'), dir2 = join(root, 'action-run');
  const plan = { ...existing.plan, permissions: ['publish:test'], actions: [{ id: 'publish', description: 'Copy verified a.txt to the approved destination', permission: 'publish:test', command: `cp a.txt ${shellQuote(output)}`, verificationCommand: `test -f ${shellQuote(output)}` }], criteria: [...existing.plan.criteria, { id: 'published', phase: 'outcome', description: 'Published file contains a', verification: 'Read published file' }] };
  const state = { ...createRun({ cwd: existing.cwd, kind: 'artifact', plan }), settings: existing.settings, jobs: [], questions: [], answers: {}, failedProviders: {} };
  approveRun(state); initializeRun(dir2, state);
  const agents = simulatedAgents(dir2, { verifier(req, report) {
    const outcome = report.criteria.find(c => c.id === 'published');
    if (outcome) { outcome.passed = existsSync(output) && readFileSync(output, 'utf8') === 'a'; outcome.detail = 'Read the actual published artifact.'; }
    else assert.equal(existsSync(output), false, 'No action before pre-action verification');
    return report;
  } });
  await controller(dir2, agents.runtime);
  const final = stateOf(dir2);
  assert.equal(final.status, 'COMPLETE');
  assert.equal(final.actionProgress.publish.status, 'verified');
  assert.equal(agents.roles.filter(r => r === 'verifier').length, 2);
  assert.equal(readFileSync(output, 'utf8'), 'a');
});

test('draft budget extension preserves planning usage and still requires plan approval', t => {
  const { root, cwd } = fixture(t), dir = join(root, 'draft');
  const plan = { ...stateOf(join(root, 'run')).plan, budgetMs: 1000 };
  initializeRun(dir, createRun({ cwd, kind: 'artifact', plan }));
  mutate(dir, s => extendBudget(s, 2000));
  const state = readRun(dir);
  assert.equal(state.budget.limitMs, 2000); assert.equal(state.plan.budgetMs, 2000);
  assert.equal(state.status, 'DRAFT'); assert.equal(state.approvedHash, undefined);
});

test('artifact integration stages directory-to-file replacement without losing the previous snapshot', t => {
  const { root, cwd } = fixture(t), worker = join(root, 'replacement');
  mkdirSync(join(cwd, 'report')); writeFileSync(join(cwd, 'report', 'old.txt'), 'preserve me');
  const base = copyArtifacts(cwd, worker);
  rmSync(join(worker, 'report'), { recursive: true }); writeFileSync(join(worker, 'report'), 'new file');
  integrateArtifacts(worker, cwd, base, ['report/**', 'report']);
  assert.equal(readFileSync(join(cwd, 'report'), 'utf8'), 'new file');
});

test('distinct actions with the same command get independent job identities', async t => {
  const { root, cwd } = fixture(t);
  const existing = stateOf(join(root, 'run'));
  const dir = join(root, 'action-identity');
  const plan = { ...existing.plan, permissions: ['deploy:stage', 'deploy:prod'],
    actions: [
      { id: 'stage', description: 'Deploy to staging', permission: 'deploy:stage', command: 'echo deployed', verificationCommand: 'echo ok' },
      { id: 'prod', description: 'Deploy to production', permission: 'deploy:prod', command: 'echo deployed', verificationCommand: 'echo ok' },
    ],
    criteria: [...existing.plan.criteria,
      { id: 'staged', phase: 'outcome', description: 'Staged', verification: 'check' },
      { id: 'deployed', phase: 'outcome', description: 'Deployed', verification: 'check' },
    ] };
  const state = { ...createRun({ cwd, kind: 'artifact', plan }), settings: existing.settings, jobs: [], questions: [], answers: {}, failedProviders: {} };
  approveRun(state); initializeRun(dir, state);
  const agents = simulatedAgents(dir, { verifier(req, report) {
    for (const c of report.criteria) c.passed = true;
    return report;
  } });
  await controller(dir, agents.runtime);
  const final = stateOf(dir);
  assert.equal(final.status, 'COMPLETE');
  const actionJobs = final.jobs.filter(j => j.kind === 'action');
  const postActionJobs = final.jobs.filter(j => j.kind === 'post-action');
  assert.equal(actionJobs.length, 2, 'Two distinct action jobs must exist');
  assert.equal(postActionJobs.length, 2, 'Two distinct post-action jobs must exist');
  assert.notEqual(actionJobs[0].id, actionJobs[1].id, 'Action job IDs must differ');
  assert.notEqual(postActionJobs[0].id, postActionJobs[1].id, 'Post-action job IDs must differ');
  assert.equal(final.actionProgress.stage.status, 'verified');
  assert.equal(final.actionProgress.prod.status, 'verified');
});

test('unclaimed action intent is relaunched on controller retry', async t => {
  const { root, cwd } = fixture(t);
  const existing = stateOf(join(root, 'run'));
  const dir = join(root, 'action-relaunch');
  const output = join(root, 'action-output.txt');
  const plan = { ...existing.plan, permissions: ['publish:test'],
    actions: [{ id: 'pub', description: 'Publish', permission: 'publish:test', command: `echo done > ${shellQuote(output)}`, verificationCommand: `test -f ${shellQuote(output)}` }],
    criteria: [...existing.plan.criteria, { id: 'published', phase: 'outcome', description: 'Published', verification: 'check' }] };
  const state = { ...createRun({ cwd, kind: 'artifact', plan }), settings: existing.settings, jobs: [], questions: [], answers: {}, failedProviders: {} };
  approveRun(state); initializeRun(dir, state);
  const agents = simulatedAgents(dir, { verifier(req, report) {
    const outcome = report.criteria.find(c => c.id === 'published');
    if (outcome) { outcome.passed = existsSync(output); outcome.detail = 'checked'; }
    return report;
  } });
  await controller(dir, agents.runtime);
  const final = stateOf(dir);
  assert.equal(final.status, 'COMPLETE');
  assert.equal(final.actionProgress.pub.status, 'verified');
  assert.ok(existsSync(output));
});

test('action job runner receives WAN_CANDIDATE_REVISION environment variable', async t => {
  const { root, cwd } = fixture(t);
  const existing = stateOf(join(root, 'run'));
  const dir = join(root, 'action-env');
  const envFile = join(root, 'candidate-env.txt');
  const plan = { ...existing.plan, permissions: ['publish:test'],
    actions: [{ id: 'check-env', description: 'Verify env', permission: 'publish:test', command: `printenv WAN_CANDIDATE_REVISION > ${shellQuote(envFile)}`, verificationCommand: `test -f ${shellQuote(envFile)}` }],
    criteria: [...existing.plan.criteria, { id: 'env-verified', phase: 'outcome', description: 'Env set', verification: 'check' }] };
  const state = { ...createRun({ cwd, kind: 'artifact', plan }), settings: existing.settings, jobs: [], questions: [], answers: {}, failedProviders: {} };
  approveRun(state); initializeRun(dir, state);
  const agents = simulatedAgents(dir, { verifier(req, report) {
    for (const c of report.criteria) c.passed = true;
    return report;
  } });
  await controller(dir, agents.runtime);
  const final = stateOf(dir);
  assert.equal(final.status, 'COMPLETE');
  assert.ok(existsSync(envFile), 'Action command must have run');
  const candidateInEnv = readFileSync(envFile, 'utf8').trim();
  assert.equal(candidateInEnv, final.candidate, 'WAN_CANDIDATE_REVISION must match the pinned candidate');
});
