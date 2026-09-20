import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, existsSync, readdirSync, linkSync, unlinkSync, fsyncSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { TestJob } from './protocol.js';
import { ownsProcess } from './ownership.js';

const LAUNCH_GRACE_MS = 5000;
type Intent = TestJob & { cwd: string; generation: number };
type Owner = { pid: number; signature: string; token: string; members?: { pid: number; signature: string }[] };
function read<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
// Publish complete, synced content without replacing an existing intent or execution claim.
function exclusive(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { unlinkSync(temp); }
  const directory = openSync(join(path, '..'), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

// The permanent execution claim is never stolen. A crashed claimed attempt is failed;
// only an intent with no claim can be recovered automatically. Retry uses a new generation.
const RUNNER = String.raw`
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const spec = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const file = name => path.join(spec.directory, name);
const signature = pid => { try { return cp.execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {encoding:'utf8'}).trim(); } catch { return ''; } };
const owner = {pid: process.pid, signature: signature(process.pid), token: require('node:crypto').randomUUID(), members: []};
if (!owner.signature) process.exit(1);
const atomic = (name, value) => { const temp = file(name + '.' + owner.token); fs.writeFileSync(temp, JSON.stringify(value), {mode:0o600}); fs.renameSync(temp, file(name)); };
const claim = file('claim.' + owner.token);
const fd = fs.openSync(claim, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); fs.closeSync(fd);
try { fs.linkSync(claim, file('execution.json')); } catch (e) { if (e.code === 'EEXIST') process.exit(0); throw e; } finally { fs.unlinkSync(claim); }
atomic('owner.json', owner);
let ended = false;
const snapshot = () => {
  try {
    const rows = cp.execFileSync('ps', ['-axo', 'pid=,pgid=,lstart='], {encoding:'utf8'}).trim().split('\n');
    owner.members = rows.flatMap(row => { const m = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); return m && +m[2] === process.pid ? [{pid:+m[1], signature:m[3].trim()}] : []; });
    atomic('owner.json', owner);
  } catch {}
};
const save = (code, signal) => { if (ended) return; ended = true; snapshot(); atomic('result.json', {exitCode:fs.existsSync(file('stop.json')) ? 1 : code ?? 1, signal, endedAt:Date.now(), candidate:spec.candidate}); clearInterval(timer); };
if (fs.existsSync(file('stop.json'))) { atomic('result.json', {exitCode:1, endedAt:Date.now(), candidate:spec.candidate}); process.exit(0); }
const env = {...process.env};
if (spec.candidate) env.WAN_CANDIDATE_REVISION = spec.candidate;
if (spec.actionId) env.WAN_ACTION_ID = spec.actionId;
const child = cp.spawn('/bin/sh', ['-c', spec.command], {cwd:spec.cwd, env, stdio:['ignore','inherit','inherit']});
snapshot();
const timer = setInterval(snapshot, 100);
child.on('error', e => { console.error(e.message); save(1, null); });
child.on('exit', save);
// The coordinator signals the entire detached group. Keep the owner alive until
// collection/escalation, even when a descendant ignores TERM.
process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch {} });
`;

function launch(intent: Intent): void {
  if (existsSync(join(intent.directory, 'execution.json')) || existsSync(join(intent.directory, 'stop.json'))) return;
  const fd = openSync(join(intent.directory, 'output.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, ['-e', RUNNER, join(intent.directory, 'intent.json')], { cwd: intent.cwd, detached: true, stdio: ['ignore', fd, fd] });
    // An unsuccessful spawn leaves a recoverable intent; never overwrite another wrapper's result.
    child.on('error', () => {});
    child.unref();
  } finally { closeSync(fd); }
}

export function startJob(runDir: string, cwd: string, command: string, candidate: string, generation = 0, kind: TestJob['kind'] = 'test', actionId?: string): TestJob {
  const id = createHash('sha256').update(JSON.stringify([candidate, command, generation, cwd, kind, actionId ?? null])).digest('hex');
  const directory = join(runDir, 'jobs', id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  exclusive(join(directory, 'intent.json'), { kind, id, command, candidate, generation, cwd, directory, pid: 0, startedAt: Date.now(), ...(actionId ? { actionId } : {}) });
  const intent = read<Intent>(join(directory, 'intent.json'))!;
  launch(intent);
  return collectJob(intent);
}

/** Merge disk intents/results with the CURRENT journal jobs inside its transaction.
 * Reconciliation does not launch commands; call startJob with the same generation
 * to recover an unclaimed intent when the run is authorized to execute. */
export function reconcileJobs(dir: string, currentJobs: TestJob[]): TestJob[] {
  const merged = new Map(currentJobs.map(job => [job.id, job]));
  const root = join(dir, 'jobs');
  if (existsSync(root)) for (const id of readdirSync(root)) {
    const intent = read<Intent>(join(root, id, 'intent.json'));
    if (intent && intent.id === id && intent.directory === join(root, id)) merged.set(id, { ...intent, ...merged.get(id) });
  }
  return [...merged.values()].map(collectJob);
}

export function collectJob(job: TestJob): TestJob {
  const owner = read<Owner>(join(job.directory, 'owner.json')) ?? read<Owner>(join(job.directory, 'execution.json'));
  const current = owner ? { ...job, pid: owner.pid } : job;
  const result = read<{candidate: string; exitCode: number; endedAt: number}>(join(job.directory, 'result.json'));
  if (result) {
    if (result.candidate !== job.candidate || !Number.isInteger(result.exitCode) || !Number.isFinite(result.endedAt)) throw new Error(`Invalid verification result for ${job.id}`);
    return { ...current, exitCode: result.exitCode, endedAt: result.endedAt };
  }
  if (job.endedAt || jobAlive(current) || Date.now() - job.startedAt < LAUNCH_GRACE_MS) return current;
  // No execution claim means no command ran; keep this intent available for recovery.
  return owner || existsSync(join(job.directory, 'stop.json')) ? { ...current, exitCode: 1, endedAt: Date.now() } : current;
}

function groupOwner(job: TestJob): Owner | undefined {
  return read<Owner>(join(job.directory, 'owner.json')) ?? read<Owner>(join(job.directory, 'execution.json'));
}
export function jobAlive(job: TestJob): boolean {
  const owner = groupOwner(job);
  if (!owner) return false;
  if (ownsProcess(owner)) return true;
  // A surviving member with the same birth identity authenticates the original group
  // after its leader exits. Never use the journal PID alone as kill authority.
  return !!owner.members?.some(member => {
    if (!ownsProcess(member)) return false;
    try { return Number(execFileSync('ps', ['-p', String(member.pid), '-o', 'pgid='], {encoding:'utf8'}).trim()) === owner.pid; }
    catch { return false; }
  });
}

export async function stopJobs(jobs: TestJob[]): Promise<void> {
  for (const job of jobs) {
    exclusive(join(job.directory, 'stop.json'), {at: Date.now()});
    const owner = groupOwner(job);
    if (owner && jobAlive(job)) { try { process.kill(-owner.pid, 'SIGTERM'); } catch {} }
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  for (const job of jobs) {
    const owner = groupOwner(job);
    if (owner && jobAlive(job)) { try { process.kill(-owner.pid, 'SIGKILL'); } catch {} }
    if (!existsSync(join(job.directory, 'result.json'))) {
      const temp = join(job.directory, `result.${randomUUID()}`);
      writeFileSync(temp, JSON.stringify({candidate:job.candidate, exitCode:1, endedAt:Date.now(), signal:'SIGTERM'}), {mode:0o600});
      renameSync(temp, join(job.directory, 'result.json'));
    }
  }
}
