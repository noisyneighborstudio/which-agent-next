import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type RunStatus = 'DRAFT' | 'APPROVED' | 'RUNNING' | 'WAITING_QUOTA' | 'PAUSED' | 'BUDGET_EXHAUSTED' | 'READY_FOR_REVIEW' | 'COMPLETE';
export type Role = 'planner' | 'coordinator' | 'worker' | 'verifier' | 'supervisor';
export interface Criterion { id: string; description: string; verification: string; phase?: 'deliverable' | 'outcome' }
export interface AuthorizedAction { id: string; description: string; permission: string; command: string; verificationCommand: string }
export interface Assignment {
  id: string; title: string; instructions: string; ownership: string[]; criteria: string[];
  dependsOn: string[]; status: 'pending' | 'running' | 'implemented' | 'integrated' | 'blocked';
  attempts: number; failures: number; baseRevision?: string; workspace?: string;
  lastProvider?: string; summary?: string; evidence?: string[]; failureReason?: string;
}
export interface Plan {
  goal: string; criteria: Criterion[]; deliverables: string[]; budgetMs: number;
  permissions: string[]; verificationCommands: string[]; tasks: Assignment[]; estimatedMs?: number;
  actions?: AuthorizedAction[];
}
export interface Invocation {
  id: string; role: Role; provider: string; startedAt: number; deadline: number;
  endedAt?: number; pid?: number; taskId?: string; logPath?: string; outcome?: string;
  reservedMs: number;
  /** Persisted accounting and candidate identity survive controller restarts. */
  allocationNumber?: number; chargedMs?: number; candidate?: string;
}
export interface Evidence {
  criterionId: string; candidate: string; passed: boolean; detail: string;
  source: 'test' | 'verifier'; invocationId?: string;
}
export interface VerificationJob {
  id?: string; kind: string; command?: string; candidate?: string; endedAt?: number; exitCode?: number;
}
export interface RunState {
  version: 1; id: string; revision: number; createdAt: number; updatedAt: number;
  cwd: string; kind: 'code' | 'artifact'; status: RunStatus; plan: Plan;
  approvedAt?: number; approvedHash?: string;
  budget: { limitMs: number; usedMs: number };
  allocation: { number: number; invocations: number; usedMs: number; maxInvocations: number; maxMs: number };
  jobs?: VerificationJob[];
  actionProgress?: Record<string, { status: 'running' | 'verified' | 'blocked'; candidate: string; jobId?: string; verificationJobId?: string }>;
  invocations: Invocation[]; evidence: Evidence[]; candidate?: string; stopRequested: boolean;
  supervisor: { heartbeat?: number; lastInspection?: number; findings: string[]; nextAction?: string };
  events: { at: number; type: string; detail: string }[];
}

export const MAX_INVOCATION_MS = 300_000;
export const MAX_ALLOCATION_INVOCATIONS = 24;
export const MAX_ALLOCATION_MS = 7_200_000;
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const statuses: RunStatus[] = ['DRAFT', 'APPROVED', 'RUNNING', 'WAITING_QUOTA', 'PAUSED', 'BUDGET_EXHAUSTED', 'READY_FOR_REVIEW', 'COMPLETE'];
const roles: Role[] = ['planner', 'coordinator', 'worker', 'verifier', 'supervisor'];
const terminal = (s: RunState): boolean => s.status === 'COMPLETE' || s.status === 'READY_FOR_REVIEW';
const active = (s: RunState): Invocation[] => s.invocations.filter(i => i.endedAt === undefined);
function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function timestamp(now: number): void { requireThat(Number.isFinite(now) && now >= 0, 'Invalid timestamp'); }
function event(s: RunState, type: string, detail: string, now: number): void {
  timestamp(now);
  s.updatedAt = Math.max(s.updatedAt, now);
  s.events.push({ at: now, type, detail });
}
function strings(value: unknown, label: string, required = false): asserts value is string[] {
  requireThat(Array.isArray(value) && value.every(nonempty) && (!required || value.length > 0), `Invalid ${label}`);
}
function unique(ids: string[], label: string): void {
  requireThat(ids.every(nonempty) && new Set(ids).size === ids.length, `Duplicate or empty ${label} id`);
}
function safeOwnership(path: string): boolean {
  // Filename stars stay within one segment; a terminal ** owns a subtree.
  if (isAbsolute(path) || /[\\\x00-\x1f:]/.test(path)) return false;
  const segments = path.split('/');
  return segments.every((part, index) => part !== '' && part !== '.' && part !== '..'
    && part !== '.git' && part !== '.wan'
    && !/[?\[\]{}!]/.test(part)
    && (!part.includes('**') || (part === '**' && index === segments.length - 1)));
}

export function validatePlan(plan: Plan): void {
  requireThat(plan && nonempty(plan.goal), 'Plan needs a goal');
  requireThat(positive(plan.budgetMs), 'Budget must be positive and finite');
  requireThat(plan.estimatedMs === undefined || positive(plan.estimatedMs), 'Invalid estimate');
  requireThat(Array.isArray(plan.criteria) && plan.criteria.length > 0, 'Plan needs criteria');
  unique(plan.criteria.map(c => c.id), 'criterion');
  requireThat(plan.criteria.every(c => safeId(c.id)), 'Invalid criterion id');
  for (const c of plan.criteria) requireThat(nonempty(c.description) && nonempty(c.verification)
    && (c.phase === undefined || c.phase === 'deliverable' || c.phase === 'outcome'), 'Invalid criterion');
  strings(plan.deliverables, 'deliverables', true);
  strings(plan.permissions, 'permissions');
  strings(plan.verificationCommands, 'verification commands');
  if (plan.actions !== undefined) {
    requireThat(Array.isArray(plan.actions), 'Invalid authorized actions');
    unique(plan.actions.map(a => a.id), 'action');
    for (const a of plan.actions) requireThat(safeId(a.id) && nonempty(a.description) && nonempty(a.command)
      && nonempty(a.verificationCommand) && nonempty(a.permission) && plan.permissions.includes(a.permission), 'Action needs explicit permission and post-action verification');
  }
  requireThat(!plan.criteria.some(c => c.phase === 'outcome') || !!plan.actions?.length, 'Outcome criteria require explicitly authorized actions');
  requireThat(plan.criteria.some(c => c.phase !== 'outcome'), 'At least one criterion must verify deliverables before external actions');
  requireThat(Array.isArray(plan.tasks) && plan.tasks.length > 0, 'Plan needs tasks');
  unique(plan.tasks.map(t => t.id), 'task');
  requireThat(plan.tasks.every(t => safeId(t.id)), 'Invalid task id');
  const criteria = new Set(plan.criteria.map(c => c.id));
  const tasks = new Map(plan.tasks.map(t => [t.id, t]));
  for (const task of plan.tasks) {
    requireThat(nonempty(task.title) && nonempty(task.instructions), 'Invalid task definition');
    strings(task.ownership, 'ownership', true);
    requireThat(task.ownership.every(safeOwnership), 'Unsafe ownership path');
    strings(task.criteria, 'task criteria', true);
    strings(task.dependsOn, 'dependencies');
    requireThat(task.criteria.every(id => criteria.has(id)), 'Unknown criterion reference');
    requireThat(task.dependsOn.every(id => tasks.has(id)), 'Unknown dependency reference');
    requireThat(['pending', 'running', 'implemented', 'integrated', 'blocked'].includes(task.status), 'Invalid task status');
    requireThat(Number.isSafeInteger(task.attempts) && task.attempts >= 0 && Number.isSafeInteger(task.failures) && task.failures >= 0, 'Invalid task counters');
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string): void {
    requireThat(!visiting.has(id), 'Cyclic task dependencies');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of tasks.keys()) visit(id);
}

/** Object key order is fixed here; array order remains part of the approved plan. */
export function approvalHash(plan: Plan): string {
  const definitions = {
    goal: plan.goal,
    criteria: plan.criteria.map(c => ({ id: c.id, description: c.description, verification: c.verification, phase: c.phase ?? 'deliverable' })),
    deliverables: plan.deliverables, budgetMs: plan.budgetMs, permissions: plan.permissions,
    verificationCommands: plan.verificationCommands, estimatedMs: plan.estimatedMs ?? null, actions: plan.actions ?? [],
    tasks: plan.tasks.map(t => ({ id: t.id, title: t.title, instructions: t.instructions,
      ownership: t.ownership, criteria: t.criteria, dependsOn: t.dependsOn })),
  };
  return createHash('sha256').update(JSON.stringify(definitions)).digest('hex');
}
export function createRun(input: { id?: string; cwd: string; kind?: 'code' | 'artifact'; plan: Plan }, now = Date.now()): RunState {
  timestamp(now);
  validatePlan(input.plan);
  requireThat(nonempty(input.cwd) && (input.id === undefined || safeId(input.id)), 'Invalid run identity');
  requireThat(input.kind === undefined || input.kind === 'code' || input.kind === 'artifact', 'Invalid run kind');
  return {
    version: 1, id: input.id ?? randomUUID(), revision: 0, createdAt: now, updatedAt: now,
    cwd: input.cwd, kind: input.kind ?? 'code', status: 'DRAFT', plan: structuredClone(input.plan),
    budget: { limitMs: input.plan.budgetMs, usedMs: 0 },
    allocation: { number: 1, invocations: 0, usedMs: 0, maxInvocations: MAX_ALLOCATION_INVOCATIONS, maxMs: MAX_ALLOCATION_MS },
    invocations: [], evidence: [], stopRequested: false, supervisor: { findings: [] },
    events: [{ at: now, type: 'created', detail: 'Run drafted' }],
  };
}
export function assertApproved(state: RunState): void {
  validatePlan(state.plan);
  requireThat(state.approvedAt !== undefined && state.approvedHash === approvalHash(state.plan), 'Plan is not approved or has changed since approval');
}
export function approveRun(state: RunState, now = Date.now()): void {
  timestamp(now);
  validatePlan(state.plan);
  if (state.approvedHash !== undefined || state.approvedAt !== undefined) {
    assertApproved(state); // Reapproval is an idempotent check, never a new authorization.
    return;
  }
  requireThat(state.status === 'DRAFT' && !state.stopRequested, 'Only an unstopped draft may be approved');
  requireThat((state.plan.estimatedMs ?? 0) <= state.plan.budgetMs, 'Estimate exceeds plan budget');
  requireThat(state.budget.limitMs === state.plan.budgetMs, 'Initial budget differs from plan');
  state.approvedHash = approvalHash(state.plan);
  state.approvedAt = now;
  state.status = 'APPROVED';
  event(state, 'approved', state.approvedHash, now);
}
export function extendBudget(state: RunState, newLimitMs: number, now = Date.now()): void {
  timestamp(now);
  const draft = state.approvedHash === undefined && state.approvedAt === undefined;
  if (!draft) assertApproved(state);
  else validatePlan(state.plan);
  requireThat(!terminal(state), 'Cannot extend a terminal run');
  requireThat(positive(newLimitMs) && newLimitMs >= state.budget.limitMs, 'Budget cannot decrease');
  if (newLimitMs === state.budget.limitMs) return;
  const previous = state.budget.limitMs;
  state.budget.limitMs = newLimitMs;
  if (draft) state.plan.budgetMs = newLimitMs;
  if (state.status === 'BUDGET_EXHAUSTED') state.status = state.stopRequested ? 'PAUSED' : 'APPROVED';
  event(state, 'budget_extended', `${previous} -> ${newLimitMs}`, now);
}

export function reserveInvocation(state: RunState, input: { id?: string; role: Role; provider: string; taskId?: string; limitMs?: number }, now = Date.now()): Invocation {
  timestamp(now);
  // The CLI must obtain an explicit user budget before creating a draft for planning.
  const planning = state.status === 'DRAFT' && state.approvedAt === undefined && state.approvedHash === undefined && input.role === 'planner';
  if (planning) {
    validatePlan(state.plan);
    requireThat(positive(state.budget.limitMs) && state.budget.limitMs === state.plan.budgetMs, 'Initial budget differs from plan');
  } else assertApproved(state);
  checkAccounting(state);
  requireThat(!terminal(state) && !state.stopRequested && state.status !== 'PAUSED' && state.status !== 'BUDGET_EXHAUSTED', 'Run cannot start an invocation');
  requireThat(roles.includes(input.role) && nonempty(input.provider), 'Invalid invocation role or provider');
  requireThat(input.taskId === undefined || state.plan.tasks.some(t => t.id === input.taskId), 'Unknown invocation task');
  const limit = input.limitMs ?? MAX_INVOCATION_MS;
  requireThat(positive(limit), 'Invalid invocation time limit');
  const id = input.id ?? randomUUID();
  requireThat(nonempty(id) && !state.invocations.some(i => i.id === id), 'Duplicate or empty invocation id');
  requireThat(state.allocation.invocations < Math.min(state.allocation.maxInvocations, MAX_ALLOCATION_INVOCATIONS), 'Allocation invocation limit reached; renew allocation');
  const outstanding = active(state).reduce((sum, i) => sum + i.reservedMs, 0);
  const remaining = state.budget.limitMs - state.budget.usedMs - outstanding;
  const allocationRemaining = Math.min(state.allocation.maxMs, MAX_ALLOCATION_MS) - state.allocation.usedMs - outstanding;
  requireThat(remaining > 0, 'No unreserved run budget remains');
  requireThat(allocationRemaining > 0, 'Allocation time limit reached; renew allocation');
  const reservedMs = Math.min(limit, MAX_INVOCATION_MS, remaining, allocationRemaining);
  const invocation: Invocation = { id, role: input.role, provider: input.provider, taskId: input.taskId,
    startedAt: now, deadline: now + reservedMs, reservedMs, allocationNumber: state.allocation.number,
    candidate: state.candidate };
  state.invocations.push(invocation);
  state.allocation.invocations++;
  if (!planning) state.status = 'RUNNING';
  event(state, 'invocation_reserved', id, now);
  return invocation;
}
function settle(state: RunState, invocation: Invocation, outcome: string, now: number, conservative: boolean): void {
  const charged = conservative ? invocation.reservedMs : Math.min(invocation.reservedMs, Math.max(0, now - invocation.startedAt));
  invocation.endedAt = Math.max(now, invocation.startedAt);
  invocation.outcome = outcome;
  invocation.chargedMs = charged;
  state.budget.usedMs += charged;
  state.allocation.usedMs += charged;
  if (state.status !== 'DRAFT') {
    if (state.budget.usedMs >= state.budget.limitMs) state.status = 'BUDGET_EXHAUSTED';
    else if (state.stopRequested) state.status = 'PAUSED';
  }
  event(state, 'invocation_finished', `${invocation.id}: ${outcome}; charged ${charged}ms`, now);
}
export function finishInvocation(state: RunState, id: string, outcome: string, now = Date.now()): void {
  timestamp(now);
  const invocation = state.invocations.find(i => i.id === id);
  requireThat(invocation, 'Unknown invocation');
  if (invocation.endedAt !== undefined) return;
  requireThat(nonempty(outcome), 'Invocation needs an outcome');
  settle(state, invocation, outcome, now, false);
}
export function reconcileInvocations(state: RunState, isAlive: (pid: number) => boolean, now = Date.now(), graceMs = 10_000): void {
  timestamp(now);
  requireThat(Number.isFinite(graceMs) && graceMs >= 0, 'Invalid reconciliation grace');
  for (const invocation of active(state)) {
    if (invocation.pid === undefined && now < Math.min(invocation.startedAt + graceMs, invocation.deadline)) continue;
    if (invocation.pid === undefined || !isAlive(invocation.pid)) {
      settle(state, invocation, 'interrupted', now, true);
    }
  }
}
export function renewAllocation(state: RunState, assessment: string, now = Date.now()): void {
  timestamp(now);
  assertApproved(state);
  checkAccounting(state);
  requireThat(nonempty(assessment), 'Renewal requires a supervisor assessment');
  requireThat(!terminal(state) && !state.stopRequested && state.status !== 'BUDGET_EXHAUSTED', 'Run cannot renew allocation');
  requireThat(active(state).length === 0, 'Cannot renew with active invocations');
  requireThat(state.budget.usedMs < state.budget.limitMs, 'Run budget exhausted');
  state.allocation = { ...state.allocation, number: state.allocation.number + 1, invocations: 0, usedMs: 0 };
  state.supervisor.lastInspection = now;
  state.supervisor.findings.push(assessment);
  event(state, 'allocation_renewed', assessment, now);
}

export function recordEvidence(state: RunState, evidence: Evidence): void {
  assertApproved(state);
  requireThat(!terminal(state), 'Cannot change evidence on a terminal run');
  requireThat(state.plan.criteria.some(c => c.id === evidence.criterionId), 'Unknown evidence criterion');
  requireThat(nonempty(evidence.candidate) && nonempty(evidence.detail) && typeof evidence.passed === 'boolean', 'Invalid evidence');
  requireThat(evidence.source === 'test' || evidence.source === 'verifier', 'Invalid evidence source');
  if (evidence.source === 'verifier') {
    const invocation = state.invocations.find(i => i.id === evidence.invocationId);
    requireThat(invocation?.role === 'verifier' && invocation.candidate === evidence.candidate, 'Evidence requires a verifier invocation on the pinned candidate');
  }
  state.evidence.push(structuredClone(evidence));
  event(state, 'evidence_recorded', `${evidence.criterionId}: ${evidence.passed}`, Date.now());
}
/** Successful invocation outcomes are "success", "passed", or "complete". */
function successful(invocation: Invocation): boolean {
  return invocation.endedAt !== undefined && ['success', 'passed', 'complete'].includes(invocation.outcome ?? '');
}
interface ReviewDecision { candidate: string; verifierInvocationId: string; supervisorInvocationId: string }
export function assertReviewEvidence(state: RunState, input: ReviewDecision, phase: 'deliverable' | 'all' = 'all'): void {
  assertApproved(state);
  requireThat(!terminal(state) && !state.stopRequested && active(state).length === 0, 'Run is stopped, terminal, or has active invocations');
  requireThat(state.jobs === undefined || (Array.isArray(state.jobs)
    && state.jobs.every(job => job && Number.isFinite(job.endedAt))), 'Run has active or invalid jobs');
  for (const command of state.plan.verificationCommands) {
    const job = state.jobs?.filter(job => job.kind === 'test' && job.command === command
      && job.candidate === input.candidate).at(-1);
    requireThat(job && Number.isFinite(job.endedAt) && job.exitCode === 0, `Missing successful test command: ${command}`);
  }
  requireThat(state.plan.tasks.every(t => t.status === 'integrated'), 'All tasks must be integrated');
  requireThat(nonempty(input.candidate) && input.candidate === state.candidate, 'Candidate must match the pinned candidate');
  const verifier = state.invocations.find(i => i.id === input.verifierInvocationId);
  const supervisor = state.invocations.find(i => i.id === input.supervisorInvocationId);
  requireThat(verifier?.role === 'verifier' && successful(verifier), 'A successful completed verifier invocation is required');
  requireThat(supervisor?.role === 'supervisor' && supervisor.id !== verifier.id && successful(supervisor), 'A separate successful supervisor invocation is required');
  requireThat(verifier.candidate === input.candidate && supervisor.candidate === input.candidate, 'Review invocations target a stale candidate');
  // A fresh verification must start after every implementation invocation has settled.
  const implementations = state.invocations.filter(i => i.role === 'worker' || i.role === 'coordinator');
  requireThat(implementations.every(i => i.endedAt !== undefined && i.endedAt <= verifier.startedAt
    && state.invocations.indexOf(i) < state.invocations.indexOf(verifier)), 'Verification predates implementation');
  requireThat(supervisor.startedAt >= verifier.endedAt! && state.invocations.indexOf(supervisor) > state.invocations.indexOf(verifier), 'Supervisor inspection predates verification');
  for (const criterion of state.plan.criteria.filter(c => phase === 'all' || c.phase !== 'outcome')) {
    const evidence = state.evidence.filter(e => e.criterionId === criterion.id && e.candidate === input.candidate
      && e.source === 'verifier' && e.invocationId === verifier.id).at(-1);
    requireThat(evidence?.passed === true, `Missing successful verifier evidence for ${criterion.id}`);
  }
}
export function markReady(state: RunState, input: ReviewDecision): void {
  requireThat(!state.plan.actions?.length, 'Authorized required actions remain; review readiness cannot replace full completion');
  assertReviewEvidence(state, input);
  state.status = 'READY_FOR_REVIEW';
  event(state, 'ready_for_review', input.candidate, Date.now());
}
export function markComplete(state: RunState, input: ReviewDecision): void {
  assertReviewEvidence(state, input);
  requireThat(!!state.plan.actions?.length, 'Use READY_FOR_REVIEW when no external outcome is authorized');
  for (const action of state.plan.actions!) {
    const progress = state.actionProgress?.[action.id];
    requireThat(progress?.status === 'verified' && progress.candidate === input.candidate, `Action ${action.id} is not independently verifiable yet`);
    requireThat(nonempty(progress!.verificationJobId), `Action ${action.id} has no recorded post-action verification job`);
    const job = state.jobs?.find(j => j.id === progress!.verificationJobId);
    requireThat(job && job.kind === 'post-action' && job.candidate === input.candidate && job.exitCode === 0 && job.endedAt !== undefined, `Missing or failed post-action evidence for action ${action.id}`);
  }
  state.status = 'COMPLETE';
  event(state, 'complete', input.candidate, Date.now());
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

class LiveLockError extends Error {}
class InitializingLockError extends Error {}
interface LockOwner { pid: number; timestamp: number; token: string }
const LOCK = '.state.lock';
function syncDirectory(dir: string): void {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function acquireLock(dir: string): () => void {
  const lockDir = join(dir, LOCK);
  const owner: LockOwner = { pid: process.pid, timestamp: Date.now(), token: randomUUID() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try { mkdirSync(lockDir, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A creator publishes its owner just after mkdir. Wait briefly for that
      // publication, but never reclaim a lock with an unknown owner.
      let files: string[];
      try { files = readdirSync(lockDir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InitializingLockError('Run lock changed before owner inspection'); throw error; }
      if (files.length === 0) throw new InitializingLockError('Run lock has an incomplete owner during initialization');
      requireThat(files.length === 1, 'Run lock is busy or has an incomplete owner');
      const ownerPath = join(lockDir, files[0]);
      let previous: LockOwner;
      try {
        const contents = readFileSync(ownerPath, 'utf8');
        if (!contents) throw new InitializingLockError('Run lock owner is being written');
        previous = JSON.parse(contents) as LockOwner;
      } catch (error) {
        if (error instanceof InitializingLockError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InitializingLockError('Run lock was released during owner inspection');
        throw new Error('Run lock is busy or has an unreadable owner');
      }
      requireThat(nonempty(previous.token) && files[0] === `${previous.token}.json`
        && Number.isSafeInteger(previous.pid) && previous.pid > 0
        && Number.isFinite(previous.timestamp) && previous.timestamp >= 0 && previous.timestamp <= Date.now(), 'Invalid run lock owner');
      if (isProcessAlive(previous.pid)) throw new LiveLockError(`Run is locked by live process ${previous.pid}`);
      // The unique owner filename is the claim: only one reclaimer can unlink it.
      // A loser must not remove the directory, which may now belong to a new owner.
      try { unlinkSync(ownerPath); }
      catch { throw new Error('Run lock changed during stale recovery; retry'); }
      rmdirSync(lockDir);
      continue;
    }
    const ownerPath = join(lockDir, `${owner.token}.json`);
    // On write failure leave the incomplete lock closed to competing writers.
    writeFileSync(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return () => {
      unlinkSync(ownerPath);
      rmdirSync(lockDir);
    };
  }
  throw new Error('Run lock contention; retry');
}
function checkAccounting(state: RunState): void {
  const allocation = state.allocation;
  requireThat(Number.isSafeInteger(allocation.number) && allocation.number >= 1
    && Number.isSafeInteger(allocation.maxInvocations) && allocation.maxInvocations > 0
    && allocation.maxInvocations <= MAX_ALLOCATION_INVOCATIONS
    && positive(allocation.maxMs) && allocation.maxMs <= MAX_ALLOCATION_MS, 'Invalid allocation bounds');
  unique(state.invocations.map(i => i.id), 'invocation');
  let total = 0;
  let currentTotal = 0;
  let currentCount = 0;
  let outstanding = 0;
  for (const invocation of state.invocations) {
    requireThat(roles.includes(invocation.role) && positive(invocation.reservedMs)
      && invocation.reservedMs <= MAX_INVOCATION_MS
      && Number.isFinite(invocation.startedAt) && invocation.startedAt >= 0
      && invocation.deadline === invocation.startedAt + invocation.reservedMs
      && Number.isSafeInteger(invocation.allocationNumber) && invocation.allocationNumber! >= 1
      && invocation.allocationNumber! <= allocation.number, 'Invalid invocation accounting');
    const current = invocation.allocationNumber === allocation.number;
    if (current) currentCount++;
    if (invocation.endedAt === undefined) {
      requireThat(current && invocation.chargedMs === undefined, 'Active invocation has invalid accounting');
      outstanding += invocation.reservedMs;
    } else {
      requireThat(Number.isFinite(invocation.endedAt) && invocation.endedAt >= invocation.startedAt
        && Number.isFinite(invocation.chargedMs) && invocation.chargedMs! >= 0
        && invocation.chargedMs! <= invocation.reservedMs, 'Invalid invocation charge');
      total += invocation.chargedMs!;
      if (current) currentTotal += invocation.chargedMs!;
    }
  }
  requireThat(state.budget.usedMs === total && allocation.usedMs === currentTotal
    && allocation.invocations === currentCount, 'Accounting counters disagree with invocation history');
  requireThat(total + outstanding <= state.budget.limitMs
    && currentTotal + outstanding <= allocation.maxMs
    && currentCount <= allocation.maxInvocations, 'Accounting exceeds budget or allocation');
}
function checkState(state: RunState): void {
  requireThat(state?.version === 1 && safeId(state.id), 'Unsupported or invalid run state');
  requireThat(Number.isSafeInteger(state.revision) && state.revision >= 0, 'Invalid run revision');
  requireThat(statuses.includes(state.status), 'Invalid run status');
  timestamp(state.createdAt); timestamp(state.updatedAt);
  requireThat(state.updatedAt >= state.createdAt, 'Invalid update timestamp');
  for (const at of [state.approvedAt, state.supervisor?.heartbeat, state.supervisor?.lastInspection]) if (at !== undefined) timestamp(at);
  validatePlan(state.plan);
  requireThat(positive(state.budget.limitMs) && Number.isFinite(state.budget.usedMs) && state.budget.usedMs >= 0, 'Invalid persisted budget');
  requireThat(Array.isArray(state.invocations) && Array.isArray(state.events) && Array.isArray(state.evidence), 'Invalid persisted history');
  for (const entry of state.events) {
    timestamp(entry?.at);
    requireThat(nonempty(entry.type) && typeof entry.detail === 'string', 'Invalid event');
  }
  for (const evidence of state.evidence) {
    requireThat(evidence && state.plan.criteria.some(c => c.id === evidence.criterionId)
      && nonempty(evidence.candidate) && nonempty(evidence.detail) && typeof evidence.passed === 'boolean'
      && ['test', 'verifier'].includes(evidence.source)
      && (evidence.invocationId === undefined || nonempty(evidence.invocationId)), 'Invalid evidence');
    if (evidence.source === 'verifier') requireThat(state.invocations.some(i => i.id === evidence.invocationId
      && i.role === 'verifier' && i.candidate === evidence.candidate), 'Invalid verifier evidence');
  }
  if (state.approvedHash === undefined && state.approvedAt === undefined) requireThat(state.plan.budgetMs === state.budget.limitMs, 'Initial budget differs from plan');
  checkAccounting(state);
  if (state.approvedHash !== undefined || state.approvedAt !== undefined) assertApproved(state);
}
export function readRun(dir: string): RunState {
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as RunState;
  checkState(state);
  return state;
}
function persist(dir: string, state: RunState, initialize: boolean): void {
  checkState(state);
  const target = join(dir, 'state.json');
  if (initialize) requireThat(!existsSync(target), 'Run already exists');
  else {
    const previous = readRun(dir);
    if (previous.approvedHash !== undefined) requireThat(previous.plan.budgetMs === state.plan.budgetMs, 'Initial plan budget cannot change');
    else requireThat(state.plan.budgetMs === state.budget.limitMs, 'Draft plan budget differs from authorized budget');
    requireThat(previous.createdAt === state.createdAt, 'Creation timestamp cannot change');
    requireThat(previous.id === state.id && previous.revision === state.revision, 'Run revision conflict; reread before writing');
    requireThat(state.budget.usedMs >= previous.budget.usedMs && state.allocation.number >= previous.allocation.number, 'Cumulative accounting cannot decrease');
    requireThat(previous.approvedHash === undefined || previous.approvedHash === state.approvedHash, 'Approval cannot be replaced');
    requireThat(state.events.length >= previous.events.length
      && previous.events.every((entry, index) => JSON.stringify(entry) === JSON.stringify(state.events[index])), 'Durable event history cannot be rewritten');
    requireThat(state.budget.limitMs >= previous.budget.limitMs, 'Budget cannot decrease');
    if (state.budget.limitMs !== previous.budget.limitMs) {
      let limit = previous.budget.limitMs;
      for (const entry of state.events.slice(previous.events.length).filter(e => e.type === 'budget_extended')) {
        const [from, to] = entry.detail.split(' -> ').map(Number);
        requireThat(from === limit && positive(to) && to > from, 'Invalid budget extension event');
        limit = to;
      }
      requireThat(limit === state.budget.limitMs, 'Budget changes require explicit extendBudget');
    }
    for (const old of previous.invocations) {
      const nextInvocation = state.invocations.find(i => i.id === old.id);
      requireThat(nextInvocation, 'Invocation history cannot be removed');
      for (const key of ['role', 'provider', 'startedAt', 'deadline', 'reservedMs', 'allocationNumber', 'candidate', 'taskId'] as const) {
        requireThat(nextInvocation[key] === old[key], 'Invocation reservation cannot be rewritten');
      }
      if (old.endedAt !== undefined) {
        requireThat(nextInvocation.endedAt === old.endedAt && nextInvocation.chargedMs === old.chargedMs
          && nextInvocation.outcome === old.outcome, 'Settled invocation cannot be rewritten');
      }
    }
  }
  const next = { ...state, updatedAt: Date.now(), revision: initialize ? state.revision : state.revision + 1 };
  const temporary = join(dir, `.state-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(next, null, 2) + '\n');
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  try { renameSync(temporary, target); syncDirectory(dir); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  state.revision = next.revision;
  state.updatedAt = next.updatedAt;
}
export function writeRun(dir: string, state: RunState): void {
  const release = acquireLock(dir);
  try { persist(dir, state, false); } finally { release(); }
}
export function initializeRun(dir: string, state: RunState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = acquireLock(dir);
  try { persist(dir, state, true); } finally { release(); }
}
/** Synchronous, fail-fast lock. */
export function withRun<T>(dir: string, fn: (state: RunState) => T): T {
  return transact(dir, fn, acquireLock(dir));
}
/** Wait up to 250ms for owner publication, or two seconds for a known live owner. */
export function withRunRetry<T>(dir: string, fn: (state: RunState) => T): T {
  const deadline = performance.now() + 2_000;
  const initializingDeadline = performance.now() + 250;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let release: () => void;
  for (;;) {
    try { release = acquireLock(dir); break; }
    catch (error) {
      const remaining = (error instanceof InitializingLockError ? initializingDeadline : deadline) - performance.now();
      if (!(error instanceof LiveLockError || error instanceof InitializingLockError) || remaining <= 0) throw error;
      Atomics.wait(sleeper, 0, 0, Math.min(25, remaining));
    }
  }
  return transact(dir, fn, release);
}
function transact<T>(dir: string, fn: (state: RunState) => T, release: () => void): T {
  try {
    const state = readRun(dir);
    const result = fn(state);
    requireThat(!(result && typeof (result as { then?: unknown }).then === 'function'), 'withRun callback must be synchronous');
    persist(dir, state, false);
    return result;
  } finally { release(); }
}
