import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readRun, withRunRetry, reserveInvocation, finishInvocation, reconcileInvocations, renewAllocation, recordEvidence, markReady, markComplete, assertReviewEvidence, assertApproved, type Role, type Assignment } from './state.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { invokeAgent, selectProvider, parseAgentReport, gitRevision, createWorktree, inspectChanges, integrateWorktree, artifactRevision, processAlive, terminateOwnedProcess, runCommand, processSignature as agentProcessSignature } from './runtime.js';
import { type LoopState, type TestJob, rolePrompt, object, textField } from './protocol.js';
import { acquireLease, processSignature, ownsProcess } from './ownership.js';
import { copyArtifacts, integrateArtifacts, inventory, ownsPath, recoverArtifactTransaction } from './artifacts.js';
import { startJob, collectJob, stopJobs, reconcileJobs } from './jobs.js';
import { publishProgress, progressText } from './progress.js';

export const stateOf = (dir: string): LoopState => readRun(dir) as LoopState;
export function mutate<T>(dir: string, fn: (state: LoopState) => T): T { return withRunRetry(dir, state => fn(state as LoopState)); }
export interface EngineRuntime { selectProvider?: typeof selectProvider; invokeAgent?: typeof invokeAgent }
const engineRuntime = new AsyncLocalStorage<EngineRuntime>();
export function event(state: LoopState, type: string, detail: string): void { state.events.push({ at: Date.now(), type, detail }); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const terminal = (s: LoopState) => ['READY_FOR_REVIEW', 'COMPLETE', 'PAUSED', 'BUDGET_EXHAUSTED'].includes(s.status);

export interface Turn { id: string; provider: string; report?: Record<string, unknown>; error?: string; timedOut?: boolean }

export async function runTurn(dir: string, role: Role, prompt: string, cwd: string, taskId?: string, differentFrom: string[] = []): Promise<Turn | undefined> {
  const state = stateOf(dir);
  const blocked = Object.entries(state.failedProviders).filter(([, until]) => until > Date.now()).map(([id]) => id);
  const selection = await (engineRuntime.getStore()?.selectProvider ?? selectProvider)({ role, exclude: blocked, preferDifferentFrom: differentFrom });
  if (!selection.provider) {
    // A missing narrator never changes run status.
    if (role === 'recap') return undefined;
    const cooldown = Object.values(state.failedProviders).filter(until => until > Date.now());
    const retryAt = selection.retryAt ?? (cooldown.length ? Math.min(...cooldown) : undefined);
    mutate(dir, s => {
      s.status = !s.approvedHash ? 'DRAFT' : retryAt ? 'WAITING_QUOTA' : 'PAUSED'; s.retryAt = retryAt;
      s.supervisor.nextAction = retryAt ? `Resume after capacity retry at ${new Date(retryAt).toISOString()}` : 'No eligible provider and no known retry time. Inspect authentication or capacity.';
      event(s, 'capacity', selection.reason);
    });
    return undefined;
  }
  const provider = selection.provider;
  const invocation = mutate(dir, s => {
    const active = s.invocations.filter(i => i.endedAt === undefined);
    if (s.stopRequested || terminal(s)) return undefined;
    if (role === 'supervisor' ? active.length > 0 : active.some(i => i.role === 'supervisor')) return undefined;
    const available = s.budget.limitMs - s.budget.usedMs - active.reduce((n, i) => n + i.reservedMs, 0);
    const reserve = ['worker', 'coordinator'].includes(role) ? Math.min(2 * s.settings.invocationMs, s.budget.limitMs * 0.2) : 0;
    const limitMs = Math.min(role === 'recap' ? RECAP_MS : s.settings.invocationMs, available - reserve);
    if (limitMs <= 0 && role === 'recap') return undefined;
    if (limitMs <= 0) {
      if (!active.length) { s.status = 'PAUSED'; s.supervisor.nextAction = 'Explicitly extend the overall budget to continue unfinished work.'; event(s, 'budget-reserve', 'Preserved remaining verification/supervision capacity.'); }
      return undefined;
    }
    // Keep one allocation slot for the supervisory renewal decision.
    if (!['supervisor', 'recap'].includes(role) && s.allocation.invocations >= s.allocation.maxInvocations - 1) return undefined;
    const i = reserveInvocation(s, { role, provider: provider.id, taskId, limitMs });
    i.logPath = join(dir, 'logs', `${i.id}.log`);
    event(s, 'invocation', `${role} ${i.id} via ${provider.id}${taskId ? ` for ${taskId}` : ''}`);
    return i;
  });
  if (!invocation) return undefined;
  mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'logs', `${invocation.id}.prompt.txt`), prompt, { mode: 0o600 });
  const abort = new AbortController();
  const timer = setInterval(() => {
    try { if (stateOf(dir).stopRequested) abort.abort(); } catch { /* State may be atomically replaced. */ }
  }, 500);
  try {
    const result = await (engineRuntime.getStore()?.invokeAgent ?? invokeAgent)({ provider, cwd, prompt, role, logPath: invocation.logPath!, timeoutMs: invocation.reservedMs, signal: abort.signal,
      onSpawn(pid) {
        const signature = processSignature(pid);
        mutate(dir, s => {
          const i = s.invocations.find(i => i.id === invocation.id)!;
          i.pid = pid;
          (i as typeof i & { signature: string }).signature = signature;
        });
      },
      onSignature(pid, signature) { mutate(dir, s => { const i = s.invocations.find(i => i.id === invocation.id)!; if (i.pid === pid) (i as typeof i & { runtimeSignature: string }).runtimeSignature = signature; }); },
    });
    let report: Record<string, unknown> | undefined, failure: string | undefined;
    if (result.timedOut) failure = 'Invocation timed out; reconcile actual partial work before another attempt.';
    else if (result.exitCode !== 0) failure = `Provider exited ${result.exitCode}: ${result.text.slice(-1500)}`;
    else { try { report = parseAgentReport(result.text); } catch (error) { failure = (error as Error).message; } }
    mutate(dir, s => {
      finishInvocation(s, invocation.id, failure ? 'failed' : 'success');
      if (result.exitCode !== 0 && !result.timedOut && role !== 'recap') s.failedProviders[provider.id] = Date.now() + 600_000;
      event(s, failure ? 'checkpoint-error' : 'checkpoint', `${role} ${invocation.id}: ${failure ?? JSON.stringify(report).slice(0, 3000)}`);
    });
    if (report) writeFileSync(join(dir, 'logs', `${invocation.id}.report.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
    const turn = { id: invocation.id, provider: provider.id, report, error: failure, timedOut: result.timedOut };
    if (role !== 'recap' && role !== 'planner') await recap(dir, role, taskId, turn);
    return turn;
  } catch (error) {
    mutate(dir, s => { finishInvocation(s, invocation.id, 'failed'); event(s, 'invocation-error', String(error)); });
    return { id: invocation.id, provider: provider.id, error: String(error) };
  } finally { clearInterval(timer); }
}

const RECAP_MS = 60_000;

/** Tail the terminal tape with a low-effort, one-line "where we are" after each turn. */
async function recap(dir: string, role: Role, taskId: string | undefined, turn: Turn): Promise<void> {
  const state = stateOf(dir);
  const result = await runTurn(dir, 'recap', `You narrate wan loop run ${state.id} for someone glancing at its terminal. Do not use tools or change anything.\n` +
    `Just finished: ${role}${taskId ? ` for ${taskId}` : ''} via ${turn.provider}: ${turn.error ?? JSON.stringify(turn.report).slice(0, 3000)}\n` +
    `Run progress:\n${progressText(state)}\n` +
    'Return WAN_RESULT followed by {"recap":string}: one or two plain sentences, under 240 characters, saying where the run stands and what comes next. Report only what the progress shows.', state.cwd)
    .catch((error: unknown): Partial<Turn> => ({ error: String(error) }));
  const text = typeof result?.report?.recap === 'string' && result.report.recap.trim()
    ? result.report.recap.trim().replace(/\s+/g, ' ')
    : `recap unavailable${result?.error ? `: ${result.error.slice(0, 200)}` : ''}`;
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${role}${taskId ? ` ${taskId}` : ''} (${turn.provider}) — ${text}`);
}

async function revision(state: LoopState, cwd = state.cwd): Promise<string> {
  if (state.kind === 'code') {
    const dirty = await runCommand('git', ['status', '--porcelain', '--untracked-files=all'], { cwd });
    if (dirty.code || dirty.stdout.trim()) throw new Error('Pinned code workspace has uncommitted changes; preserve and reconcile before verification.');
    return gitRevision(cwd);
  }
  recoverArtifactTransaction(cwd);
  return artifactRevision(cwd);
}

async function prepareAssignment(dir: string, assignment: Assignment): Promise<string> {
  if (assignment.workspace && existsSync(assignment.workspace)) return assignment.workspace;
  const state = stateOf(dir);
  const attempt = assignment.attempts + 1;
  const cwd = join(dir, 'workers', `${assignment.id}-${attempt}`);
  const base = await revision(state);
  // Persist path/base before the OS operation. A restart adopts only this recorded workspace.
  mutate(dir, s => { const t = s.plan.tasks.find(t => t.id === assignment.id)!; t.workspace = cwd; t.baseRevision = base; });
  if (state.kind === 'code') await createWorktree(state.cwd, cwd, `wan/${state.id}/${assignment.id}-${attempt}`, base);
  else {
    const files = copyArtifacts(state.cwd, cwd);
    writeFileSync(join(dir, `${assignment.id}.base.json`), JSON.stringify(files), { mode: 0o600 });
  }
  return cwd;
}

async function assignmentChanges(state: LoopState, task: Assignment): Promise<{ files: string[]; diff: string }> {
  if (state.kind === 'code') return inspectChanges(task.workspace!, task.baseRevision!);
  const current = inventory(task.workspace!);
  const base = JSON.parse(readFileSync(join(task.workspace!, '..', '..', `${task.id}.base.json`), 'utf8')) as Record<string, string>;
  const files = [...new Set([...Object.keys(base), ...Object.keys(current)])].filter(file => base[file] !== current[file]);
  return { files, diff: JSON.stringify({ base, current }) };
}

async function work(dir: string, id: string, differentFrom: string[]): Promise<void> {
  let state = stateOf(dir), task = state.plan.tasks.find(t => t.id === id)!;
  const cwd = await prepareAssignment(dir, task);
  mutate(dir, s => { const t = s.plan.tasks.find(t => t.id === id)!; t.status = 'running'; t.attempts++; });
  state = stateOf(dir); task = state.plan.tasks.find(t => t.id === id)!;
  const before = await assignmentChanges(state, task);
  const turn = await runTurn(dir, 'worker', rolePrompt(state, 'worker',
    `Assignment: ${JSON.stringify(task)}. Only modify owned paths: ${task.ownership.join(', ')}.\n` +
    `Partial work already present, inspect before continuing: ${JSON.stringify(before.files)}.\n` +
    `Return {status:"implemented"|"checkpoint"|"blocked",summary:string,evidence:[string],next:string}. "implemented" means the entire assignment is implemented, not the entire goal verified. Implement missing source as well as tests.`), cwd, id, differentFrom);
  if (!turn) { mutate(dir, s => { s.plan.tasks.find(t => t.id === id)!.status = 'pending'; }); return; }
  state = stateOf(dir); task = state.plan.tasks.find(t => t.id === id)!;
  const changes = await assignmentChanges(state, task);
  const violation = changes.files.find(file => !ownsPath(file, task.ownership));
  mutate(dir, s => {
    const t = s.plan.tasks.find(t => t.id === id)!;
    t.lastProvider = turn.provider;
    t.summary = typeof turn.report?.summary === 'string' ? turn.report.summary : turn.error ?? 'No valid checkpoint';
    const status = turn.report?.status;
    const noProgress = JSON.stringify(before) === JSON.stringify(changes);
    if (violation || turn.error || status === 'blocked' || !['checkpoint', 'implemented'].includes(String(status))) {
      t.status = 'pending'; t.failures++; t.failureReason = violation ? `Unowned change: ${violation}` : t.summary;
    } else {
      t.status = status === 'implemented' ? 'implemented' : 'pending';
      if (noProgress && status !== 'implemented') t.failures++; else t.failures = 0;
      t.failureReason = noProgress && status !== 'implemented' ? 'No source or artifact progress in this checkpoint.' : undefined;
    }
    t.evidence = Array.isArray(turn.report?.evidence) ? turn.report.evidence.filter((v): v is string => typeof v === 'string') : [];
    event(s, 'assignment', `${id}: ${t.status}; ${t.summary}`);
  });
}

async function integrate(dir: string, task: Assignment): Promise<void> {
  const state = stateOf(dir), changes = await assignmentChanges(state, task);
  if (changes.files.some(file => !ownsPath(file, task.ownership))) throw new Error(`Unowned changes in ${task.id}; preserve work and reconcile.`);
  const turn = await runTurn(dir, 'coordinator', rolePrompt(state, 'coordinator',
    `Inspect actual files and changes in this worker workspace before deciding integration. Assignment ${JSON.stringify(task)}. Changes:\n${changes.diff.slice(0, 80_000)}\n` +
    `Do not modify source. Return {decision:"integrate"|"revise"|"blocked",summary:string}. Inspect missing behavior and weak tests, not just syntax. Worker evidence is a claim.`), task.workspace!, task.id, task.lastProvider ? [task.lastProvider] : []);
  if (!turn) return;
  if (turn.error || turn.report?.decision !== 'integrate') {
    mutate(dir, s => { const t = s.plan.tasks.find(t => t.id === task.id)!; t.status = 'pending'; t.failures++; t.failureReason = turn.error ?? String(turn.report?.summary); });
    return;
  }
  let candidate: string;
  const hashes = Object.fromEntries(changes.files.map(path => [path, fileIdentity(task.workspace!, path)]));
  mutate(dir, s => { s.integrationIntent = { taskId: task.id, parent: s.candidate ?? task.baseRevision!, files: changes.files, hashes }; });
  if (state.kind === 'code') candidate = (await integrateWorktree(state.cwd, task.workspace!, task.baseRevision!, task.ownership)).revision;
  else {
    const base = JSON.parse(readFileSync(join(dir, `${task.id}.base.json`), 'utf8'));
    integrateArtifacts(task.workspace!, state.cwd, base, task.ownership);
    candidate = await artifactRevision(state.cwd);
  }
  mutate(dir, s => {
    const t = s.plan.tasks.find(t => t.id === task.id)!;
    t.status = 'integrated'; t.failures = 0; s.candidate = candidate;
    s.integrationIntent = undefined;
    // Any new candidate invalidates prior evidence and verifier decisions.
    s.lastVerifier = undefined; s.lastSupervisor = undefined;
    event(s, 'integration', `${task.id} integrated at ${candidate}; ${turn.report!.summary}`);
  });
  await safeProgress(dir);
}

function fileIdentity(cwd: string, path: string): string | null {
  const full = join(cwd, path);
  try {
    const stat = lstatSync(full);
    const data = stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full);
    return createHash('sha256').update(String(stat.mode & 0o777)).update(data).digest('hex');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function reconcileIntegration(dir: string): Promise<void> {
  const state = stateOf(dir), intent = state.integrationIntent;
  if (!intent) return;
  if (state.kind === 'artifact') recoverArtifactTransaction(state.cwd);
  if (intent.files.every(path => fileIdentity(state.cwd, path) === intent.hashes[path])) {
    const candidate = await revision(state);
    mutate(dir, s => {
      s.plan.tasks.find(t => t.id === intent.taskId)!.status = 'integrated'; s.candidate = candidate; s.integrationIntent = undefined;
      s.lastVerifier = undefined; s.lastSupervisor = undefined;
      event(s, 'integration-recovered', `${intent.taskId} was already applied at ${candidate}; no replay.`);
    });
  } else if (await revision(state) === intent.parent) {
    mutate(dir, s => { s.integrationIntent = undefined; event(s, 'integration-recovered', `${intent.taskId} not yet applied; retained inspected worker changes.`); });
  } else throw new Error('Integration interrupted with conflicting changes. Source and intent preserved for inspection.');
}

async function verificationIntegrity(state: LoopState, cwd: string, candidate: string, baseline: string): Promise<void> {
  if (state.kind === 'code') {
    if (await gitRevision(cwd) !== candidate) throw new Error('Verification HEAD differs from pinned candidate.');
    const dirty = await runCommand('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd });
    if (dirty.code) throw new Error('Verification modified tracked source; evidence cannot certify the pinned candidate.');
    // New source files that are not ignored by the project are also candidate changes.
    const extra = await runCommand('git', ['ls-files', '--others', '--exclude-standard'], { cwd });
    if (extra.stdout.trim()) throw new Error('Verification created untracked deliverables; candidate must be integrated and pinned again.');
  } else if (await artifactRevision(cwd) !== baseline) throw new Error('Verification changed deliverables; evidence targets a different artifact.');
}

async function assess(dir: string, instruction: string): Promise<Turn | undefined> {
  const state = stateOf(dir);
  const turn = await runTurn(dir, 'supervisor', rolePrompt(state, 'supervisor',
    `Independently inspect actual source/artifacts, logs at ${dir}/logs, owned job results, and acceptance evidence. Do not modify implementation. ${instruction}\n` +
    `Return {decision:"ready"|"continue"|"pause",candidate:string,summary:string,findings:[string],strategy?:string}. "ready" requires every original criterion and a successful fresh independent verifier on the exact candidate. Never waive criteria or expand spending or external authority.`), state.cwd, undefined, state.invocations.filter(i => i.role === 'worker').map(i => i.provider));
  if (turn) mutate(dir, s => {
    s.supervisor.lastInspection = Date.now(); s.supervisor.heartbeat = Date.now();
    s.supervisor.findings = turn.error ? [turn.error] : Array.isArray(turn.report?.findings) ? turn.report.findings.filter((v): v is string => typeof v === 'string') : [];
    s.supervisor.nextAction = String(turn.report?.summary ?? turn.error);
    if (turn.report?.decision === 'pause' || turn.error) { s.status = 'PAUSED'; event(s, 'pause', s.supervisor.nextAction); }
  });
  return turn;
}

async function ensureAllocation(dir: string): Promise<boolean> {
  const state = stateOf(dir);
  const running = state.invocations.filter(i => !i.endedAt);
  const reserved = running.reduce((sum, i) => sum + i.reservedMs, 0);
  if (state.allocation.invocations < state.allocation.maxInvocations - 2 && state.allocation.usedMs + reserved < state.allocation.maxMs - 2 * state.settings.invocationMs) return true;
  if (running.length) return false;
  const assessment = await assess(dir, 'This allocation is ending. Decide whether another bounded allocation is useful within the existing overall budget.');
  if (assessment?.report?.decision === 'continue') mutate(dir, s => renewAllocation(s, textField(assessment.report!, 'summary')));
  return !!assessment && !terminal(stateOf(dir));
}

async function diagnoseStalls(dir: string): Promise<boolean> {
  const stalled = stateOf(dir).plan.tasks.filter(t => t.failures >= 3);
  if (!stalled.length) return true;
  const turn = await assess(dir, `These assignments failed at least three times: ${JSON.stringify(stalled)}. Diagnose the obstacle. Continue only with a materially different, specific strategy; otherwise pause. Do not claim that a provider change alone fixes a source-level failure.`);
  const strategy = turn?.report?.strategy;
  if (turn?.report?.decision !== 'continue' || typeof strategy !== 'string' || !strategy.trim()) {
    mutate(dir, s => { s.status = 'PAUSED'; event(s, 'stall', 'No viable changed approach after repeated failures.'); }); return false;
  }
  mutate(dir, s => {
    for (const old of stalled) {
      const task = s.plan.tasks.find(t => t.id === old.id)!;
      // Keep approved task definitions intact; persist steering as progress.
      if (task.summary?.includes(strategy)) { s.status = 'PAUSED'; event(s, 'stall', 'Supervisor repeated the same recovery strategy.'); continue; }
      task.summary = `Supervisor recovery strategy: ${strategy}`; task.failures = 0; task.status = 'pending';
    }
    event(s, 'recovery-strategy', strategy);
  });
  return !terminal(stateOf(dir));
}

async function verify(dir: string): Promise<void> {
  let state = stateOf(dir);
  const candidate = await revision(state);
  if (!state.candidate) mutate(dir, s => { s.candidate = candidate; });
  if (state.candidate && state.candidate !== candidate) throw new Error('Candidate changed outside controller integration; reconcile before verification.');
  const checkDir = join(dir, 'verification', candidate.replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (!existsSync(checkDir)) {
    if (state.kind === 'code') await createWorktree(state.cwd, checkDir, `wan/${state.id}/verify-${candidate.slice(0, 12)}`, candidate);
    else copyArtifacts(state.cwd, checkDir);
  }
  const baseline = state.kind === 'artifact' ? candidate : await artifactRevision(checkDir);
  await verificationIntegrity(state, checkDir, candidate, baseline);
  mutate(dir, s => { if (!s.verification || s.verification.candidate !== candidate) s.verification = { candidate, baseline, directory: checkDir, generation: 0 }; });
  state = stateOf(dir);
  mutate(dir, s => { s.jobs = reconcileJobs(dir, s.jobs); });
  state = stateOf(dir);
  mutate(dir, s => { s.jobs = s.jobs.map(collectJob); });
  state = stateOf(dir);
  // One at a time, in order, stopping at the first failure -- a shell `&&` chain. Plans list
  // stages that share state (build, start, test, teardown); launched together, every stage
  // after the first fails on a precondition that simply has not happened yet.
  for (const command of state.plan.verificationCommands) {
    const previous = state.jobs.filter(j => j.kind === 'test' && j.candidate === candidate && j.command === command).at(-1);
    if (!previous || !previous.endedAt && previous.pid === 0) {
      // startJob's durable intent and execution claim make crash recovery idempotent.
      const job = startJob(dir, checkDir, command, candidate, state.verification?.generation ?? 0);
      mutate(dir, s => { s.jobs = reconcileJobs(dir, s.jobs); event(s, 'test-start', `${job.id}: ${command}`); });
      return;
    }
    if (!previous.endedAt) return;
    if (previous.exitCode !== 0) break;
  }
  const jobs = state.jobs.filter(j => j.candidate === candidate && j.kind === 'test');
  if (jobs.some(j => !j.endedAt)) return;
  await verificationIntegrity(state, checkDir, candidate, baseline);
  if (jobs.some(j => j.exitCode !== 0)) {
    if (!await verificationObstacle(dir, `tests:${candidate}:${jobs.filter(j => j.exitCode !== 0).map(j => j.command).join('|')}`)) return;
    const turn = await assess(dir, `Verification commands failed: ${JSON.stringify(jobs)}. Diagnose. Continue only if implementation assignments can repair the failure within the approved contract; otherwise pause.`);
    if (turn?.report?.decision === 'continue') mutate(dir, s => {
      for (const task of s.plan.tasks) { task.status = 'pending'; task.failures++; task.summary = `Verification failed: ${turn.report!.summary}`; task.workspace = undefined; }
      s.lastVerifier = undefined;
    });
    return;
  }
  const actions = state.plan.actions ?? [];
  const preAction = state.preActionVerification?.candidate === candidate;
  if (actions.length && preAction && !await executeActions(dir, candidate)) return;
  state = stateOf(dir);
  const reviewCriteria = actions.length && !preAction ? state.plan.criteria.filter(c => c.phase !== 'outcome') : state.plan.criteria;
  const before = await artifactRevision(checkDir);
  const turn = await runTurn(dir, 'verifier', rolePrompt(state, 'verifier',
    `You are a fresh independent verifier. Inspect the pinned candidate ${candidate} in this workspace and actual command results: ${JSON.stringify(jobs)}. Do not change deliverables or acceptance criteria. Inspect original requirements, not just worker summaries.\n` +
    `Review these criteria in this phase: ${JSON.stringify(reviewCriteria)}. ${actions.length && !preAction ? 'This is pre-action verification. Outcome criteria will be checked independently after the explicitly approved actions; do not mark them passed yet.' : 'Include every approved criterion, including post-action outcomes where present.'}\n` +
    `Return {candidate:"${candidate}",criteria:[{id:string,passed:boolean,detail:string}],summary:string}. Include exactly the listed criteria with concrete evidence and failures. Reject missing behavior even if tests pass.`), checkDir, undefined, state.invocations.filter(i => ['worker', 'coordinator'].includes(i.role)).map(i => i.provider));
  if (!turn) return;
  if (turn.error || before !== await artifactRevision(checkDir) || turn.report?.candidate !== candidate || !Array.isArray(turn.report?.criteria)) {
    mutate(dir, s => { s.status = 'PAUSED'; event(s, 'verification-rejected', turn.error ?? 'Verifier changed the candidate or returned invalid evidence.'); }); return;
  }
  const supplied = turn.report.criteria.map(object);
  if (supplied.length !== reviewCriteria.length || new Set(supplied.map(c => c.id)).size !== supplied.length) throw new Error('Verifier did not return exactly one result per approved criterion in this phase.');
  mutate(dir, s => {
    for (const criterion of reviewCriteria) {
      const evidence = supplied.find(c => c.id === criterion.id);
      if (!evidence || typeof evidence.passed !== 'boolean') throw new Error(`Missing verifier evidence for ${criterion.id}`);
      recordEvidence(s, { criterionId: criterion.id, candidate, passed: evidence.passed, detail: textField(evidence, 'detail'), source: 'verifier', invocationId: turn.id });
    }
    s.lastVerifier = turn.id;
  });
  if (supplied.some(e => !e.passed)) {
    if (preAction && supplied.some(e => !e.passed && state.plan.criteria.find(c => c.id === e.id)?.phase === 'outcome')) {
      mutate(dir, s => { s.status = 'PAUSED'; event(s, 'action-outcome-rejected', 'Independent verification rejected an external outcome. Preserve action evidence; do not blindly repeat external effects.'); }); return;
    }
    if (!await verificationObstacle(dir, `criteria:${candidate}:${supplied.filter(e => !e.passed).map(e => e.id).sort().join('|')}`)) return;
    mutate(dir, s => {
      const failed = supplied.filter(e => !e.passed).map(e => String(e.id));
      for (const task of s.plan.tasks.filter(t => t.criteria.some(id => failed.includes(id)))) { task.status = 'pending'; task.failures++; task.workspace = undefined; task.summary = `Independent verification rejected: ${JSON.stringify(supplied.filter(e => !e.passed))}`; }
      event(s, 'verification-failed', String(turn.report!.summary));
    });
    return;
  }
  const supervisor = await assess(dir, `Decide whether the exact candidate ${candidate} satisfies the ${actions.length && !preAction ? 'deliverable-phase' : 'entire set of'} approved criteria using fresh verifier ${turn.id}. ${actions.length && !preAction ? 'Return ready only to permit the explicitly approved actions next. Outcome criteria remain pending until post-action verification; this is not completion.' : ''}`);
  if (supervisor?.report?.decision === 'ready' && supervisor.report.candidate === candidate) {
    if (await revision(stateOf(dir)) !== candidate) throw new Error('Candidate changed before final decision.');
    await verificationIntegrity(stateOf(dir), checkDir, candidate, baseline);
    // Required publication must succeed before a terminal state disables supervision.
    await publishProgress(dir);
    const published = stateOf(dir);
    if (published.plan.permissions.includes('github:pr') && (!published.pr?.commentId || published.pr.publishedCandidate !== candidate)) throw new Error('Verified candidate has not been delivered to the required PR. Publication remains an open obligation.');
    const decision = { candidate, verifierInvocationId: turn.id, supervisorInvocationId: supervisor.id };
    if (actions.length && !preAction) {
      mutate(dir, s => { assertReviewEvidence(s, decision, 'deliverable'); s.preActionVerification = { candidate, verifier: turn.id, supervisor: supervisor.id }; event(s, 'pre-action-verified', candidate); });
      return;
    }
    mutate(dir, s => { s.lastSupervisor = supervisor.id; if (actions.length) markComplete(s, decision); else markReady(s, decision); event(s, 'ready', `Independent evidence accepted for ${candidate}`); });
    writeFileSync(join(dir, 'final-evidence.json'), JSON.stringify(stateOf(dir), null, 2), { mode: 0o600 });
  } else if (supervisor?.report?.decision === 'continue') {
    mutate(dir, s => { s.status = 'PAUSED'; event(s, 'verification-rejected', 'Supervisor declined completion. Inspect findings before assigning a specific repair.'); });
  }
}

async function executeActions(dir: string, candidate: string): Promise<boolean> {
  const state = stateOf(dir);
  if (!state.preActionVerification || state.preActionVerification.candidate !== candidate) throw new Error('Actions require prior independent verification of this candidate.');
  for (const action of state.plan.actions ?? []) {
    if (!state.plan.permissions.includes(action.permission)) throw new Error(`Action ${action.id} lacks explicit permission.`);
    let progress = stateOf(dir).actionProgress?.[action.id];
    if (progress?.status === 'verified') continue;
    if (!progress) {
      mutate(dir, s => { s.actionProgress ??= {}; s.actionProgress[action.id] = { status: 'running', candidate }; event(s, 'action-intent', `${action.id}: ${action.description}`); });
      const job = startJob(dir, state.cwd, action.command, candidate, 0, 'action', action.id);
      mutate(dir, s => { s.jobs = reconcileJobs(dir, s.jobs); s.actionProgress![action.id].jobId = job.id; });
      return false;
    }
    mutate(dir, s => { s.jobs = reconcileJobs(dir, s.jobs); s.jobs = s.jobs.map(collectJob); });
    progress = stateOf(dir).actionProgress![action.id];
    const actionJob = progress.jobId ? stateOf(dir).jobs.find(j => j.id === progress!.jobId) : undefined;
    if (actionJob && !actionJob.endedAt) {
      if (actionJob.pid === 0) startJob(dir, state.cwd, action.command, candidate, 0, 'action', action.id);
      return false;
    }
    if (!progress.verificationJobId) {
      const job = startJob(dir, state.cwd, action.verificationCommand, candidate, 0, 'post-action', action.id);
      mutate(dir, s => { s.jobs = reconcileJobs(dir, s.jobs); s.actionProgress![action.id].verificationJobId = job.id; });
      return false;
    }
    mutate(dir, s => { s.jobs = s.jobs.map(collectJob); });
    const checked = stateOf(dir).jobs.find(j => j.id === progress!.verificationJobId);
    if (checked && !checked.endedAt) {
      if (checked.pid === 0) startJob(dir, state.cwd, action.verificationCommand, candidate, 0, 'post-action', action.id);
      return false;
    }
    if (!checked?.endedAt) return false;
    if (checked.exitCode !== 0) {
      mutate(dir, s => { s.actionProgress![action.id].status = 'blocked'; s.status = 'PAUSED'; event(s, 'action-blocked', `${action.id}: post-action verification failed. External intervention or a newly approved repair may be required; no blind replay.`); });
      return false;
    }
    mutate(dir, s => { s.actionProgress![action.id].status = 'verified'; event(s, 'action-verified', `${action.id}: actual post-action check passed; independent outcome review pending.`); });
  }
  return true;
}

async function verificationObstacle(dir: string, key: string): Promise<boolean> {
  const obstacle = mutate(dir, s => {
    s.obstacles ??= {};
    const entry = s.obstacles[key] ??= { attempts: 0 };
    entry.attempts++; event(s, 'verification-obstacle', `${key}: attempt ${entry.attempts}`); return entry;
  });
  if (obstacle.attempts < 3) return true;
  const turn = await assess(dir, `The same verification obstacle has recurred ${obstacle.attempts} times: ${key}. Previous strategy: ${obstacle.strategy ?? 'none'}. Diagnose and provide a materially different strategy or pause. Do not merely repeat the failed test or accept a worker completion claim.`);
  const strategy = turn?.report?.strategy;
  if (turn?.report?.decision !== 'continue' || typeof strategy !== 'string' || !strategy.trim() || strategy === obstacle.strategy) {
    mutate(dir, s => { s.status = 'PAUSED'; event(s, 'stall', `Repeated verification obstacle without a new viable strategy: ${key}`); }); return false;
  }
  mutate(dir, s => { s.obstacles![key].strategy = strategy; event(s, 'recovery-strategy', strategy); });
  return true;
}

async function safeProgress(dir: string): Promise<void> {
  try { await publishProgress(dir); }
  catch (error) { mutate(dir, s => { const detail = `Progress publication failed: ${String(error)}`; if (s.events.at(-1)?.detail !== detail) event(s, 'publication-error', detail); }); }
}

export async function controller(dir: string, runtime: EngineRuntime = {}): Promise<void> {
  return engineRuntime.run(runtime, () => controllerOwned(dir));
}

async function controllerOwned(dir: string): Promise<void> {
  const release = mutate(dir, () => acquireLease(dir, 'controller'));
  const active = new Map<string, Promise<void>>();
  try {
    mutate(dir, s => {
      assertApproved(s);
      const surviving = s.invocations.filter(i => !i.endedAt && i.pid && processAlive(i.pid));
      if (surviving.length) throw new Error('Surviving agent processes own work. Monitor must reconcile them before controller recovery.');
      reconcileInvocations(s, processAlive);
      if (s.stopRequested || terminal(s)) throw new Error('Run is stopped; use explicit resume after inspecting state.');
      s.host = { pid: process.pid, signature: processSignature(process.pid), heartbeat: Date.now(), session: `wan-${s.id}` };
      s.status = 'RUNNING'; event(s, 'controller-start', `Controller pid ${process.pid}`);
      for (const t of s.plan.tasks) if (t.status === 'running') t.status = 'pending';
    });
    await reconcileIntegration(dir);
    const stop = () => mutate(dir, s => { s.stopRequested = true; event(s, 'stop-requested', 'Controller received termination signal.'); });
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try {
      while (true) {
        mutate(dir, s => { s.host!.heartbeat = Date.now(); s.jobs = reconcileJobs(dir, s.jobs); });
        let state = stateOf(dir);
        if (state.stopRequested || terminal(state)) break;
        if (state.status === 'WAITING_QUOTA') {
          if (state.retryAt && Date.now() >= state.retryAt) mutate(dir, s => { s.status = 'RUNNING'; s.retryAt = undefined; });
          else { await sleep(1000); continue; }
        }
        // A separate monitor may be assessing this run. Wait at the checkpoint
        // instead of creating worker attempts that cannot reserve an invocation.
        if (state.invocations.some(i => i.endedAt === undefined && i.role === 'supervisor')) {
          await sleep(500);
          continue;
        }
        if (!await ensureAllocation(dir)) { await sleep(500); continue; }
        if (!active.size && !await diagnoseStalls(dir)) break;
        state = stateOf(dir);
        if (terminal(state) || state.stopRequested) break;
        const unintegrated = state.plan.tasks.find(t => t.status === 'implemented');
        if (unintegrated && !active.size) { await integrate(dir, unintegrated); continue; }
        if (state.plan.tasks.every(t => t.status === 'integrated') && !active.size) { await verify(dir); await safeProgress(dir); await sleep(500); continue; }
        const activeInvocations = state.invocations.filter(i => !i.endedAt);
        const availableMs = state.budget.limitMs - state.budget.usedMs - activeInvocations.reduce((sum, i) => sum + i.reservedMs, 0);
        // Keep enough time for final verification and supervisory assessment.
        const reserveMs = Math.min(2 * state.settings.invocationMs, state.budget.limitMs * 0.2);
        if (availableMs <= reserveMs && !active.size) {
          mutate(dir, s => { s.status = 'PAUSED'; event(s, 'budget-reserve', 'Remaining budget is reserved for verification/supervision; unfinished work needs an explicit budget extension.'); s.supervisor.nextAction = 'Approve a larger budget or an explicitly revised goal.'; }); break;
        }
        const ready = state.plan.tasks.filter(t => t.status === 'pending' && !active.has(t.id) && t.failures < 3 && t.dependsOn.every(id => state.plan.tasks.find(t => t.id === id)?.status === 'integrated'));
        for (const task of ready) {
          if (active.size >= state.settings.concurrency || availableMs <= reserveMs) break;
          // Do not let parallel assignments compete for overlapping ownership.
          const busy = state.plan.tasks.filter(t => active.has(t.id));
          if (busy.some(t => t.ownership.some(a => task.ownership.some(b => a === '**' || b === '**' || ownsPath(a.replace(/\/\*\*$/, '/x'), [b]) || ownsPath(b.replace(/\/\*\*$/, '/x'), [a]))))) continue;
          const providers = activeInvocations.map(i => i.provider);
          const promise = work(dir, task.id, providers).catch(error => {
            mutate(dir, s => { const t = s.plan.tasks.find(t => t.id === task.id)!; t.status = 'pending'; t.failures++; t.failureReason = String(error); event(s, 'worker-error', `${task.id}: ${String(error)}`); });
          }).finally(() => active.delete(task.id));
          active.set(task.id, promise);
        }
        if (!active.size && !ready.length) { mutate(dir, s => { s.status = 'PAUSED'; event(s, 'blocked', 'No runnable assignment; inspect dependencies and blockers.'); }); break; }
        await sleep(500);
      }
      await Promise.allSettled(active.values());
      const final = stateOf(dir);
      if (final.stopRequested) mutate(dir, s => { if (!['READY_FOR_REVIEW', 'COMPLETE'].includes(s.status)) s.status = 'PAUSED'; event(s, 'stopped', 'Graceful stop preserved checkpoints and unfinished obligations.'); });
      if (final.stopRequested || ['READY_FOR_REVIEW', 'COMPLETE'].includes(stateOf(dir).status)) {
        await stopJobs(stateOf(dir).jobs);
        mutate(dir, s => { s.jobs = s.jobs.map(collectJob); });
      }
      await safeProgress(dir);
    } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
  } catch (error) {
    mutate(dir, s => { s.status = 'PAUSED'; event(s, 'controller-error', String(error)); s.supervisor.nextAction = 'Inspect preserved work and repair or resume within authorization.'; });
    await safeProgress(dir);
    throw error;
  } finally {
    mutate(dir, s => { if (s.host?.pid === process.pid) s.host = undefined; });
    release();
  }
}

export async function inspectRun(dir: string): Promise<string[]> {
  const state = stateOf(dir), findings: string[] = [];
  if (state.host && !ownsProcess(state.host)) findings.push('Controller process is dead.');
  if (state.host && Date.now() - state.host.heartbeat > 120_000) findings.push('Controller heartbeat is stale.');
  for (const invocation of state.invocations.filter(i => !i.endedAt)) {
    if (invocation.pid && !processAlive(invocation.pid)) findings.push(`Invocation ${invocation.id} died before settlement.`);
    if (Date.now() > invocation.deadline + 5000) {
      const signed = invocation as typeof invocation & { signature?: string; runtimeSignature?: string };
      if (signed.pid && signed.signature && ownsProcess({ pid: signed.pid, signature: signed.signature })) {
        const signature = signed.runtimeSignature ?? await agentProcessSignature(signed.pid);
        if (signature) await terminateOwnedProcess(signed.pid, { signature });
        findings.push(`Stopped overdue owned invocation ${invocation.id}.`);
      } else findings.push(`Overdue invocation ${invocation.id} has no confirmed process ownership; no process killed.`);
    }
  }
  if (state.plan.tasks.some(t => t.failures >= 3)) findings.push('Repeated failure requires a changed approach or pause.');
  const jobs = state.jobs.map(collectJob);
  if (jobs.some(j => !j.endedAt && Date.now() - j.startedAt > 3_600_000)) findings.push('Verification job has exceeded one hour; inspect for a hang instead of endless polling.');
  if (state.stopRequested || findings.some(f => f.includes('one hour'))) await stopJobs(jobs);
  mutate(dir, s => {
    s.supervisor.heartbeat = Date.now(); s.supervisor.lastInspection = Date.now(); s.supervisor.findings = findings;
    s.jobs = reconcileJobs(dir, s.jobs);
    reconcileInvocations(s, processAlive);
    if (findings.some(f => f.includes('one hour'))) { s.status = 'PAUSED'; event(s, 'stale-job', findings.join(' ')); }
  });
  return findings;
}

export async function supervisoryAssessment(dir: string): Promise<void> {
  if (terminal(stateOf(dir))) return;
  const state = stateOf(dir);
  if (state.invocations.some(i => !i.endedAt)) {
    mutate(dir, s => { s.supervisor.nextAction = 'Workers are healthy; inspect at the next checkpoint.'; }); return;
  }
  if (state.status === 'WAITING_QUOTA') return;
  await assess(dir, 'Recurring supervisory check: inspect progress, liveness, source changes, evidence, budgets, integration, and PR state. Do not disturb healthy work.');
}
