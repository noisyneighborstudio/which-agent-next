import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, initializeRun, reserveInvocation, finishInvocation, readRun, withRun } from '../dist/loop/state.js';
import { DEFAULT_SETTINGS, seedPlan, plannerPrompt } from '../dist/loop/protocol.js';
import { draftPlan } from '../dist/loop/interview.js';
import { integrateArtifacts, copyArtifacts, ownsPath } from '../dist/loop/artifacts.js';
import { prepareWorkspace } from '../dist/loop/cli.js';

function checkpoint(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wan-plan-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = { ...createRun({ cwd: dir, plan: seedPlan('Implement the complete brief', 100000) }), settings: DEFAULT_SETTINGS, jobs: [], questions: [], answers: {}, failedProviders: {} };
  const prompt = plannerPrompt(state);
  const invocation = reserveInvocation(state, { role: 'planner', provider: 'fixture', limitMs: 1000 });
  finishInvocation(state, invocation.id, 'success', invocation.startedAt + 10);
  initializeRun(dir, state); mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'logs', invocation.id + '.prompt.txt'), prompt);
  const plan = structuredClone(state.plan); plan.tasks[0].ownership = ['src/bottom-nav*'];
  writeFileSync(join(dir, 'logs', invocation.id + '.report.json'), JSON.stringify({ plan, questions: [] }));
  return dir;
}

test('resume accepts the preserved planner report without spending another invocation', async t => {
  const dir = checkpoint(t);
  await draftPlan(dir, async () => { assert.fail('Must reuse the completed planner turn'); });
  const state = readRun(dir);
  assert.deepEqual(state.plan.tasks[0].ownership, ['src/bottom-nav*']);
  assert.equal(state.invocations.length, 1);
  assert.equal(state.budget.usedMs, 10);
  assert.equal(state.status, 'DRAFT');
  assert.equal(state.approvedHash, undefined);
});

test('new interview answers invalidate the preserved planner response', async t => {
  const dir = checkpoint(t);
  withRun(dir, s => { s.answers.delivery = 'New requirement'; });
  let called = false;
  await assert.rejects(draftPlan(dir, async () => { called = true; throw new Error('fresh planning required'); }), /fresh planning required/);
  assert.equal(called, true);
});

test('filename ownership globs integrate matching files without widening to siblings', t => {
  const root = mkdtempSync(join(tmpdir(), 'wan-owned-glob-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'target'), worker = join(root, 'worker'); mkdirSync(target);
  const base = copyArtifacts(target, worker); mkdirSync(join(worker, 'src'));
  writeFileSync(join(worker, 'src', 'bottom-nav.tsx'), 'navigation');
  writeFileSync(join(worker, 'src', 'unrelated.tsx'), 'unowned');
  assert.throws(() => integrateArtifacts(worker, target, base, ['src/bottom-nav*']), /unowned/);
  rmSync(join(worker, 'src', 'unrelated.tsx'));
  integrateArtifacts(worker, target, base, ['src/bottom-nav*']);
  assert.equal(readFileSync(join(target, 'src', 'bottom-nav.tsx'), 'utf8'), 'navigation');
  assert.equal(ownsPath('src/child/bottom-nav.tsx', ['src/bottom-nav*']), false);
  assert.equal(ownsPath('.git/config', ['**']), false);
});

test('workspace preparation preserves untracked input documents in the isolated branch', async t => {
  const dir = checkpoint(t), source = join(dir, 'user-project'); mkdirSync(source);
  writeFileSync(join(source, 'BRIEF.md'), 'User brief; never change the original.');
  withRun(dir, state => { state.cwd = source; });
  const calls = [];
  await prepareWorkspace(dir, {
    runCommand: async (_command, _args, options) => { assert.equal(options.cwd, source); return { code: 0, stdout: '?? BRIEF.md\n', stderr: '' }; },
    gitRevision: async cwd => { assert.equal(cwd, source); return 'base-revision'; },
    createWorktree: async (repo, target, branch, base) => { assert.equal(repo, source); assert.equal(base, 'base-revision'); mkdirSync(target); calls.push('worktree'); },
    integrateWorktree: async (target, from, base, ownership) => {
      assert.equal(target, join(dir, 'integration')); assert.equal(from, source);
      assert.equal(base, 'base-revision'); assert.deepEqual(ownership, ['**']);
      writeFileSync(join(target, 'BRIEF.md'), readFileSync(join(from, 'BRIEF.md')));
      calls.push('snapshot'); return { revision: 'snapshot-revision', integrated: true, files: ['BRIEF.md'], reason: 'fixture' };
    },
  });
  assert.deepEqual(calls, ['worktree', 'snapshot']);
  assert.equal(readRun(dir).cwd, join(dir, 'integration'));
  assert.equal(readFileSync(join(source, 'BRIEF.md'), 'utf8'), 'User brief; never change the original.');
  assert.equal(readFileSync(join(dir, 'integration', 'BRIEF.md'), 'utf8'), 'User brief; never change the original.');
});
