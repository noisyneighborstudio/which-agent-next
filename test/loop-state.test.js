import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  createRun, validatePlan, approveRun, assertApproved, approvalHash, extendBudget,
  reserveInvocation, finishInvocation, reconcileInvocations, renewAllocation,
  recordEvidence, markReady, initializeRun, readRun, writeRun, withRun, withRunRetry, isProcessAlive,
} from '../dist/loop/state.js';

function plan(budgetMs = 1_000_000) {
  return {
    goal: 'Produce a tested implementation', budgetMs, permissions: [],
    criteria: [{ id: 'works', description: 'Works correctly', verification: 'Run acceptance tests' }],
    deliverables: ['Implementation'], verificationCommands: [],
    tasks: [{ id: 'build', title: 'Build it', instructions: 'Implement the behavior', ownership: ['src/**'],
      criteria: ['works'], dependsOn: [], status: 'pending', attempts: 0, failures: 0 }],
  };
}
function run(budgetMs) {
  const state = createRun({ cwd: '/project', plan: plan(budgetMs) }, 100);
  approveRun(state, 101);
  return state;
}
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wan-state-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const reserve = (s, id, role = 'worker', now = 200, limitMs = 100) => reserveInvocation(s, { id, role, provider: 'test', limitMs }, now);
function reviewable() {
  const s = run();
  reserve(s, 'implementation', 'worker', 200);
  finishInvocation(s, 'implementation', 'success', 220);
  s.plan.tasks[0].status = 'integrated';
  s.candidate = 'sha256:candidate-a';
  reserve(s, 'verify', 'verifier', 230);
  recordEvidence(s, { criterionId: 'works', candidate: s.candidate, passed: true,
    detail: 'Acceptance suite passed', source: 'verifier', invocationId: 'verify' });
  finishInvocation(s, 'verify', 'success', 250);
  reserve(s, 'inspect', 'supervisor', 260);
  finishInvocation(s, 'inspect', 'success', 280);
  return s;
}
const ready = s => markReady(s, { candidate: s.candidate, verifierInvocationId: 'verify', supervisorInvocationId: 'inspect' });

test('drafts are isolated copies; expensive estimates block approval, not drafting', () => {
  const p = plan(100);
  p.estimatedMs = 101;
  const s = createRun({ cwd: '/project', plan: p }, 0);
  p.tasks[0].title = 'Changed outside run';
  assert.equal(s.plan.tasks[0].title, 'Build it');
  assert.throws(() => approveRun(s, 1), /Estimate/);
  assert.equal(s.status, 'DRAFT');
});

test('plan validation rejects cycles, dangling references, duplicate IDs and unsafe paths', () => {
  for (const path of ['../escape', '/root/file', 'src/../../etc', 'C:/file', 'src\\file', 'src//file', 'src/*', '.git', '.wan', '.git/config', '.wan/**', 'src/.git/config', 'src/.wan/**', 'src/./file', 'src/\0file']) {
    const p = plan(); p.tasks[0].ownership = [path];
    assert.throws(() => validatePlan(p), /ownership/, path);
  }
  for (const path of ['**', 'src/**', 'src/file.ts', 'README.md']) {
    const p = plan(); p.tasks[0].ownership = [path]; validatePlan(p);
  }
  const cyclic = plan();
  cyclic.tasks.push({ ...cyclic.tasks[0], id: 'second', dependsOn: ['build'] });
  cyclic.tasks[0].dependsOn = ['second'];
  assert.throws(() => validatePlan(cyclic), /Cyclic/);
  const mutations = [
    p => { p.tasks[0].criteria = ['missing']; },
    p => { p.tasks[0].dependsOn = ['missing']; },
    p => { p.tasks.push(structuredClone(p.tasks[0])); },
    p => { p.criteria.push(structuredClone(p.criteria[0])); },
    p => { p.tasks = []; }, p => { p.criteria = []; }, p => { p.goal = ' '; },
    p => { p.deliverables = []; }, p => { p.budgetMs = Infinity; }, p => { p.budgetMs = 0; },
  ];
  for (const mutate of mutations) { const p = plan(); mutate(p); assert.throws(() => validatePlan(p)); }
});

test('approval hashes definitions, permits progress and refuses replacement approvals', () => {
  const s = run();
  const hash = s.approvedHash;
  s.plan.tasks[0].status = 'implemented'; s.plan.tasks[0].attempts++;
  s.plan.tasks[0].workspace = '/scratch'; s.plan.tasks[0].summary = 'Done';
  assertApproved(s);
  approveRun(s, 999);
  assert.equal(s.approvedAt, 101);
  assert.equal(s.approvedHash, hash);
  const reordered = { ...s.plan, criteria: s.plan.criteria.map(c => ({ verification: c.verification, id: c.id, description: c.description })) };
  assert.equal(approvalHash(reordered), hash);
  for (const mutate of [p => { p.goal += '!'; }, p => { p.permissions.push('network'); },
    p => { p.tasks[0].instructions += '!'; }, p => { p.budgetMs++; }, p => { p.verificationCommands.push('new-command'); }]) {
    const changed = structuredClone(s); mutate(changed.plan);
    assert.throws(() => assertApproved(changed), /changed/);
    assert.throws(() => approveRun(changed), /changed/);
    assert.throws(() => reserve(changed, 'forbidden'), /changed/);
  }
});

test('outstanding reservations prevent parallel overspend; all roles count and cap is hard', () => {
  const s = run(350_000);
  const first = reserveInvocation(s, { role: 'planner', provider: 'a', limitMs: 900_000 }, 200);
  const second = reserveInvocation(s, { role: 'supervisor', provider: 'b' }, 200);
  assert.equal(first.reservedMs, 300_000);
  assert.equal(second.reservedMs, 50_000);
  assert.equal(second.deadline, 50_200);
  assert.equal(s.allocation.invocations, 2);
  assert.throws(() => reserve(s, 'third'), /unreserved/);
  finishInvocation(s, first.id, 'success', 300);
  assert.equal(s.budget.usedMs, 100);
  assert.equal(reserveInvocation(s, { role: 'coordinator', provider: 'a' }, 400).reservedMs, 299_900);
});

test('settlement is idempotent, charges elapsed work only, and never exceeds reservation', () => {
  const s = run(300);
  reserve(s, 'one', 'worker', 200, 100);
  finishInvocation(s, 'one', 'success', 220);
  finishInvocation(s, 'one', 'failed', 9999);
  assert.equal(s.budget.usedMs, 20);
  assert.equal(s.invocations[0].outcome, 'success');
  reserve(s, 'two', 'verifier', 50_000, 500);
  finishInvocation(s, 'two', 'timeout', 99_000);
  assert.equal(s.budget.usedMs, 300);
  assert.equal(s.status, 'BUDGET_EXHAUSTED');
  s.status = 'APPROVED';
  assert.throws(() => reserve(s, 'reset'), /budget/);
});

test('reconciliation conservatively settles unstarted/dead work and leaves live work alone', () => {
  const s = run(500);
  reserve(s, 'unstarted');
  reserve(s, 'dead').pid = 123;
  reserve(s, 'live').pid = 456;
  reconcileInvocations(s, pid => pid === 456, 301);
  assert.equal(s.budget.usedMs, 200);
  assert.equal(s.invocations[0].chargedMs, 100);
  assert.equal(s.invocations[1].outcome, 'interrupted');
  assert.equal(s.invocations[2].endedAt, undefined);
  reconcileInvocations(s, pid => pid === 456, 999);
  assert.equal(s.budget.usedMs, 200);
  finishInvocation(s, 'live', 'success', 220);
  assert.equal(s.budget.usedMs, 220);
});

test('allocation renewal retains cumulative run accounting across restart', t => {
  const dir = directory(t);
  const s = run(10_000);
  for (let n = 0; n < 24; n++) {
    reserve(s, `job-${n}`, 'worker', 200, 100);
    finishInvocation(s, `job-${n}`, 'success', 210);
  }
  assert.throws(() => reserve(s, 'extra'), /Allocation invocation/);
  assert.throws(() => renewAllocation(s, ' '), /assessment/);
  initializeRun(dir, s);
  withRun(dir, state => renewAllocation(state, 'Reviewed progress and remaining budget', 300));
  const loaded = readRun(dir);
  assert.equal(loaded.budget.usedMs, 240);
  assert.equal(loaded.allocation.number, 2);
  assert.equal(loaded.allocation.usedMs, 0);
  assert.equal(loaded.allocation.invocations, 0);
  assert.equal(loaded.invocations.length, 24);
  assert.equal(loaded.invocations.reduce((sum, i) => sum + i.chargedMs, 0), 240);
  reserve(loaded, 'renewed');
  assert.throws(() => renewAllocation(loaded, 'Still active'), /active/);
});

test('allocation time bounds reserve capacity independently from the total budget', () => {
  const s = run(10_000);
  s.allocation.maxMs = 150;
  reserve(s, 'one');
  assert.equal(reserve(s, 'two').reservedMs, 50);
  assert.throws(() => reserve(s, 'three'), /Allocation time/);
  finishInvocation(s, 'one', 'timeout', 400);
  finishInvocation(s, 'two', 'timeout', 400);
  assert.equal(s.budget.usedMs, 150);
  assert.throws(() => reserve(s, 'four'), /Allocation time/);
  renewAllocation(s, 'Continue after inspection', 500);
  assert.equal(reserve(s, 'five').reservedMs, 100);
  assert.equal(s.budget.usedMs, 150);
});

test('budget extension is explicit, audited and does not replace plan approval', () => {
  const s = run(100);
  reserve(s, 'one'); finishInvocation(s, 'one', 'timeout', 300);
  assert.throws(() => renewAllocation(s, 'more'), /cannot renew/);
  const hash = s.approvedHash;
  assert.throws(() => extendBudget(s, 99), /decrease/);
  extendBudget(s, 200, 400);
  assertApproved(s);
  assert.equal(s.plan.budgetMs, 100);
  assert.equal(s.approvedHash, hash);
  assert.equal(s.budget.usedMs, 100);
  assert.equal(s.budget.limitMs, 200);
  assert.equal(s.status, 'APPROVED');
  assert.equal(s.events.at(-1).type, 'budget_extended');
  assert.equal(reserve(s, 'two').reservedMs, 100);
});

test('unapproved, stopped, paused and terminal runs cannot reserve', () => {
  const draft = createRun({ cwd: '/project', plan: plan() });
  assert.throws(() => reserve(draft, 'worker', 'worker'), /approved/);
  for (const status of ['PAUSED', 'READY_FOR_REVIEW', 'COMPLETE', 'BUDGET_EXHAUSTED']) {
    const s = run(); s.status = status;
    assert.throws(() => reserve(s, 'one'), /cannot start/);
  }
  const s = run(); s.stopRequested = true;
  assert.throws(() => reserve(s, 'one'), /cannot start/);
  assert.throws(() => renewAllocation(s, 'continue'), /cannot renew/);
});

test('only fresh verifier evidence and independent supervisor inspection reach review', () => {
  const s = reviewable();
  ready(s);
  assert.equal(s.status, 'READY_FOR_REVIEW');
  assert.notEqual(s.status, 'COMPLETE');
});

test('completion rejects worker claims, stale candidates, missing evidence, active work and stop', () => {
  const mutations = [
    s => { s.plan.tasks[0].status = 'implemented'; },
    s => { s.evidence[0].source = 'test'; },
    s => { s.evidence[0].candidate = 'old'; },
    s => { s.candidate = 'new'; },
    s => { s.evidence[0].invocationId = 'implementation'; },
    s => { s.invocations[1].role = 'worker'; },
    s => { s.invocations[1].outcome = 'failed'; },
    s => { s.invocations[2].outcome = 'failed'; },
    s => { s.invocations[2].endedAt = undefined; },
    s => { s.invocations[1].startedAt = 201; },
    s => { s.invocations[2].startedAt = 240; },
    s => { s.stopRequested = true; },
    s => { s.evidence = []; },
    s => { s.evidence.push({ ...s.evidence[0], passed: false }); },
    s => { reserve(s, 'later-work', 'worker', 300); finishInvocation(s, 'later-work', 'success', 310); },
  ];
  for (const mutate of mutations) {
    const s = reviewable(); mutate(s);
    assert.throws(() => ready(s));
    assert.notEqual(s.status, 'READY_FOR_REVIEW');
  }
  const s = reviewable();
  assert.throws(() => markReady(s, { candidate: s.candidate, verifierInvocationId: 'verify', supervisorInvocationId: 'verify' }), /separate/);
  assert.throws(() => recordEvidence(s, { ...s.evidence[0], invocationId: 'implementation' }), /verifier/);
});

test('atomic store protects permissions, refuses initialization overwrite and rejects stale revisions', t => {
  const dir = directory(t);
  const s = run(); initializeRun(dir, s);
  assert.equal(statSync(join(dir, 'state.json')).mode & 0o777, 0o600);
  assert.throws(() => initializeRun(dir, run()), /already exists/);
  const stale = readRun(dir);
  withRun(dir, current => { current.supervisor.findings.push('first'); });
  assert.equal(readRun(dir).revision, 1);
  stale.supervisor.findings.push('lost update');
  assert.throws(() => writeRun(dir, stale), /revision conflict/);
  assert.deepEqual(readRun(dir).supervisor.findings, ['first']);
  const before = readFileSync(join(dir, 'state.json'), 'utf8');
  assert.throws(() => withRun(dir, current => { current.status = 'COMPLETE'; throw new Error('abort'); }), /abort/);
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before);
  assert.equal(existsSync(join(dir, '.state.lock')), false);
  assert.throws(() => withRun(dir, () => Promise.resolve()), /synchronous/);
  withRun(dir, current => { current.supervisor.findings.push('lock released'); });
});

test('live cross-process lock cannot be overwritten, even with an old timestamp', async t => {
  const dir = directory(t); initializeRun(dir, run());
  const moduleUrl = new URL('../dist/loop/state.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withRun } from ${JSON.stringify(moduleUrl)};
    withRun(${JSON.stringify(dir)}, state => {
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      state.supervisor.findings.push('child committed');
    });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const completion = once(child, 'exit');
  await once(child.stdout, 'data');
  assert.throws(() => withRun(dir, () => {}), /locked by live/);
  assert.throws(() => writeRun(dir, readRun(dir)), /locked by live/);
  withRunRetry(dir, state => { state.supervisor.findings.push('parent committed'); });
  const [code] = await completion;
  assert.equal(code, 0);
  assert.deepEqual(readRun(dir).supervisor.findings, ['child committed', 'parent committed']);
});

test('dead lock owners are reclaimed safely; ambiguous owners are never guessed', t => {
  const dir = directory(t); initializeRun(dir, run());
  const dead = spawnSync(process.execPath, ['-e', '']);
  assert.equal(isProcessAlive(dead.pid), false);
  const lockDir = join(dir, '.state.lock'); mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'dead-token.json'), JSON.stringify({ pid: dead.pid, timestamp: 1, token: 'dead-token' }));
  withRun(dir, s => { s.supervisor.findings.push('recovered'); });
  assert.equal(readRun(dir).revision, 1);
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'live-token.json'), JSON.stringify({ pid: process.pid, timestamp: 1, token: 'live-token' }));
  assert.throws(() => withRun(dir, () => {}), /locked by live/);
  rmSync(lockDir, { recursive: true }); mkdirSync(lockDir);
  assert.throws(() => withRun(dir, () => {}), /incomplete owner/);
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), false);
});

test('separate processes cannot reserve the same remaining budget', async t => {
  const dir = directory(t); initializeRun(dir, run(100));
  const moduleUrl = new URL('../dist/loop/state.js', import.meta.url).href;
  async function contender(id) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { withRun, reserveInvocation } from ${JSON.stringify(moduleUrl)};
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          withRun(${JSON.stringify(dir)}, s => reserveInvocation(s, { id: ${JSON.stringify(id)}, role: 'worker', provider: 'test', limitMs: 100 }));
          process.exit(0);
        } catch (error) {
          if (/budget/.test(error.message)) process.exit(2);
          if (!/lock|ENOENT|EEXIST/.test(error.message)) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      process.exit(3);
    `], { stdio: 'pipe' });
    const [code] = await once(child, 'exit');
    return code;
  }
  const results = await Promise.all([contender('first'), contender('second')]);
  assert.deepEqual(results.sort(), [0, 2]);
  const state = readRun(dir);
  assert.equal(state.invocations.length, 1);
  assert.equal(state.invocations[0].reservedMs, 100);
  withRun(dir, s => reconcileInvocations(s, () => false, Date.now(), 0));
  assert.equal(readRun(dir).budget.usedMs, 100);
  assert.equal(readRun(dir).status, 'BUDGET_EXHAUSTED');
});

test('store rejects unaudited budget changes, accounting resets, and history removal', t => {
  const dir = directory(t);
  const s = run(1000);
  reserve(s, 'one'); finishInvocation(s, 'one', 'success', 210);
  initializeRun(dir, s);
  assert.throws(() => withRun(dir, current => { current.budget.limitMs = 2000; }), /extendBudget/);
  assert.throws(() => withRun(dir, current => { current.budget.usedMs = 0; }), /Accounting counters/);
  assert.throws(() => withRun(dir, current => { current.allocation.invocations = 0; }), /Accounting counters/);
  assert.throws(() => withRun(dir, current => { current.events = []; }), /event history/);
  assert.throws(() => withRun(dir, current => {
    current.invocations = []; current.budget.usedMs = 0;
    current.allocation.usedMs = 0; current.allocation.invocations = 0;
  }), /Cumulative accounting/);
  withRun(dir, current => { extendBudget(current, 2000); extendBudget(current, 3000); });
  assert.equal(readRun(dir).budget.limitMs, 3000);
  assert.equal(readRun(dir).budget.usedMs, 10);
  const reset = readRun(dir); reset.allocation.invocations = 0;
  assert.throws(() => reserve(reset, 'two'), /Accounting counters/);
});

test('every criterion needs evidence from the selected fresh verifier', () => {
  const p = plan();
  p.criteria.push({ id: 'safe', description: 'Handles failure', verification: 'Failure suite' });
  const s = createRun({ cwd: '/project', plan: p }, 100); approveRun(s, 101);
  s.plan.tasks[0].status = 'integrated'; s.candidate = 'pinned';
  reserve(s, 'old-verifier', 'verifier', 200);
  recordEvidence(s, { criterionId: 'safe', candidate: 'pinned', source: 'verifier', passed: true,
    detail: 'Old inspection', invocationId: 'old-verifier' });
  finishInvocation(s, 'old-verifier', 'success', 210);
  reserve(s, 'verify', 'verifier', 220);
  recordEvidence(s, { criterionId: 'works', candidate: 'pinned', source: 'verifier', passed: true,
    detail: 'Current inspection', invocationId: 'verify' });
  finishInvocation(s, 'verify', 'success', 230);
  reserve(s, 'inspect', 'supervisor', 240); finishInvocation(s, 'inspect', 'success', 250);
  assert.throws(() => ready(s), /safe/);
  recordEvidence(s, { criterionId: 'safe', candidate: 'pinned', source: 'verifier', passed: true,
    detail: 'Current failure suite', invocationId: 'verify' });
  ready(s);
  assert.equal(s.status, 'READY_FOR_REVIEW');
});


test('directory identifiers accept UUIDs and reject unsafe or oversized names', () => {
  for (const id of ['../escape', '.', 'a/b', 'a\\b', '-first', '_first', 'a b', 'a'.repeat(81), '']) {
    assert.throws(() => createRun({ id, cwd: '/project', plan: plan() }), /identity/);
    for (const collection of ['tasks', 'criteria']) {
      const p = plan(); p[collection][0].id = id;
      assert.throws(() => validatePlan(p), /id/);
    }
  }
  for (const id of ['a', 'A_9-z', 'a'.repeat(80), '12345678-1234-1234-1234-123456789abc']) {
    assert.equal(createRun({ id, cwd: '/project', plan: plan() }).id, id);
  }
});

test('draft planning consumes the explicit budget without authorizing implementation', t => {
  const dir = directory(t);
  const s = createRun({ cwd: '/project', plan: plan(100) }, 100);
  initializeRun(dir, s);
  withRun(dir, current => reserve(current, 'planning', 'planner', 200, 80));
  assert.equal(readRun(dir).status, 'DRAFT');
  withRun(dir, current => finishInvocation(current, 'planning', 'success', 230));
  const planned = readRun(dir);
  assert.equal(planned.status, 'DRAFT');
  assert.equal(planned.budget.usedMs, 30);
  assert.equal(planned.allocation.usedMs, 30);
  assert.equal(planned.allocation.invocations, 1);
  for (const role of ['worker', 'coordinator', 'verifier', 'supervisor']) {
    assert.throws(() => reserve(planned, role, role), /approved/);
  }
  withRun(dir, current => { current.plan.goal = 'Refined goal'; });
  assert.throws(() => withRun(dir, current => { current.plan.budgetMs = 200; }), /budget/i);
  assert.throws(() => withRun(dir, current => { current.plan.budgetMs = 200; current.budget.limitMs = 200; }), /budget/i);
  withRun(dir, current => approveRun(current, 300));
  assert.equal(reserve(readRun(dir), 'implementation').reservedMs, 70);
  const exhausted = createRun({ cwd: '/project', plan: plan(10) }, 100);
  reserve(exhausted, 'planner', 'planner', 200);
  finishInvocation(exhausted, 'planner', 'success', 220);
  assert.equal(exhausted.status, 'DRAFT');
  assert.throws(() => reserve(exhausted, 'extra', 'planner'), /budget/);
  const stopped = createRun({ cwd: '/project', plan: plan() }); stopped.stopRequested = true;
  assert.throws(() => reserve(stopped, 'planner', 'planner'), /cannot start/);
  const invalid = createRun({ cwd: '/project', plan: plan() }); invalid.plan.goal = '';
  assert.throws(() => reserve(invalid, 'planner', 'planner'), /goal/);
  const unknown = createRun({ cwd: '/project', plan: plan() }); unknown.budget.limitMs = NaN;
  assert.throws(() => reserve(unknown, 'planner', 'planner'), /budget/);
});

test('reconciliation grants launch grace but releases abandoned reservations', () => {
  const s = run();
  reserve(s, 'launching', 'worker', 1_000, 30_000);
  reconcileInvocations(s, () => false, 10_999);
  assert.equal(s.invocations[0].endedAt, undefined);
  reconcileInvocations(s, () => false, 11_000);
  assert.equal(s.invocations[0].endedAt, 11_000);
  assert.equal(s.budget.usedMs, 30_000);
  reserve(s, 'short', 'worker', 12_000, 100);
  reconcileInvocations(s, () => false, 12_100);
  assert.equal(s.invocations[1].endedAt, 12_100);
  reserve(s, 'custom', 'worker', 13_000, 30_000);
  reconcileInvocations(s, () => false, 13_000, 0);
  assert.equal(s.invocations[2].endedAt, 13_000);
  assert.throws(() => reconcileInvocations(s, () => false, 14_000, -1), /grace/);
});

test('store validates statuses, timestamps and evidence on reads and writes', t => {
  const dir = directory(t); initializeRun(dir, reviewable());
  const baseline = readRun(dir);
  const mutations = [
    s => { s.status = 'UNKNOWN'; }, s => { s.id = '../bad'; },
    s => { s.createdAt = -1; }, s => { s.updatedAt = 'today'; },
    s => { s.approvedAt = -1; }, s => { s.supervisor.heartbeat = -1; },
    s => { s.supervisor.lastInspection = 'now'; }, s => { s.events[0].at = -1; },
    s => { s.evidence[0].passed = 'yes'; }, s => { s.evidence[0].source = 'worker'; },
    s => { s.evidence[0].detail = ''; }, s => { s.evidence[0].candidate = ''; },
    s => { s.evidence[0].criterionId = 'missing'; }, s => { s.evidence[0].invocationId = 123; },
    s => { s.evidence[0] = null; },
  ];
  for (const mutate of mutations) {
    assert.throws(() => withRun(dir, mutate));
    const invalid = structuredClone(baseline); mutate(invalid);
    writeFileSync(join(dir, 'state.json'), JSON.stringify(invalid));
    assert.throws(() => readRun(dir));
    writeFileSync(join(dir, 'state.json'), JSON.stringify(baseline));
  }
  const before = Date.now();
  withRun(dir, s => { s.plan.tasks[0].summary = 'Progress'; });
  assert.ok(readRun(dir).updatedAt >= before);
  assert.ok(readRun(dir).updatedAt <= Date.now());
});

test('retry never repeats callbacks or retries damaged locks', t => {
  const dir = directory(t); initializeRun(dir, run());
  let calls = 0;
  assert.throws(() => withRunRetry(dir, () => { calls++; throw new Error('Run is locked by live process fake'); }), /fake/);
  assert.equal(calls, 1);
  for (const owner of [undefined, 'broken json', JSON.stringify({ pid: process.pid, timestamp: -1, token: 'owner' })]) {
    const lock = join(dir, '.state.lock'); mkdirSync(lock);
    if (owner !== undefined) writeFileSync(join(lock, 'owner.json'), owner);
    const start = performance.now();
    assert.throws(() => withRunRetry(dir, () => { calls++; }));
    assert.ok(performance.now() - start < 1_000);
    assert.equal(calls, 1);
    rmSync(lock, { recursive: true });
  }
});


test('completion independently requires settled jobs and successful candidate test commands', () => {
  function tested() {
    const s = reviewable();
    s.plan.verificationCommands = ['node --test'];
    s.approvedHash = approvalHash(s.plan);
    s.jobs = [{ kind: 'test', command: 'node --test', candidate: s.candidate, endedAt: 225, exitCode: 0 }];
    return s;
  }
  ready(tested());
  for (const mutate of [
    s => { delete s.jobs; }, s => { s.jobs = []; },
    s => { s.jobs[0].candidate = 'old'; }, s => { s.jobs[0].exitCode = 1; },
    s => { delete s.jobs[0].endedAt; }, s => { s.jobs[0].kind = 'worker'; },
    s => { s.jobs[0].command = 'other'; },
    s => { s.jobs.push({ kind: 'artifact' }); },
    s => { s.jobs.push({ ...s.jobs[0], exitCode: 1 }); },
  ]) {
    const s = tested(); mutate(s); assert.throws(() => ready(s), /jobs|test command/);
  }
  const s = reviewable(); s.jobs = [{ kind: 'artifact' }];
  assert.throws(() => ready(s), /jobs/);
});

test('live lock retry has a bounded two-second wait', t => {
  const dir = directory(t); initializeRun(dir, run());
  const lock = join(dir, '.state.lock'); mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: 'owner' }));
  const start = performance.now();
  assert.throws(() => withRunRetry(dir, () => assert.fail('must not run')), /locked by live/);
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 1_900 && elapsed < 3_500, `elapsed ${elapsed}ms`);
});
