import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdirSync, readdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmuxStart, tmuxAlive, runCommand, serviceDefinition } from './runtime.js';
import { acquireLease, ownsProcess, processSignature, hostId } from './ownership.js';
import { inspectRun, supervisoryAssessment, mutate, stateOf, event } from './engine.js';
import { serveDashboard, recordProgress } from './progress.js';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface HostCommands {
  alive: typeof tmuxAlive;
  command: typeof runCommand;
  start: typeof tmuxStart;
}
const commands: HostCommands = { alive: tmuxAlive, command: runCommand, start: tmuxStart };
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Shared by initial launch, monitor recovery, and host-service recovery. */
export async function startPane(dir: string, name: string, role: '_controller' | '_monitor', boundary: HostCommands = commands): Promise<'started' | 'pending' | 'registered'> {
  let release: (() => void) | undefined;
  const deadline = Date.now() + 15_000;
  while (!release) {
    try { release = acquireLease(dir, `${role.slice(1)}-launch`); }
    catch (error) { if (Date.now() >= deadline) throw error; await sleep(50); }
  }
  try {
    const state = stateOf(dir);
    const owner = role === '_controller' ? state.host : state.monitor;
    const claimPath = join(dir, `${role.slice(1)}-starting.json`);
    if (ownsProcess(owner)) {
      if (existsSync(claimPath)) unlinkSync(claimPath);
      return 'registered';
    }
    if (role === '_controller' && (state.stopRequested || ['DRAFT', 'PAUSED', 'BUDGET_EXHAUSTED', 'READY_FOR_REVIEW', 'COMPLETE'].includes(state.status))) return 'pending';
    const live = await boundary.alive(name);
    if (live) {
      const pane = await boundary.command('tmux', ['display-message', '-p', '-t', `${name}:0.0`, '#{pane_dead}']);
      if (pane.code) throw new Error(pane.stderr);
      if (pane.stdout.trim() !== '1') {
        const claim = existsSync(claimPath) ? JSON.parse(readFileSync(claimPath, 'utf8')) : undefined;
        if (!claim || claim.name !== name) throw new Error(`Existing live tmux session ${name} has no launch claim; preserved for inspection.`);
        if (Date.now() - claim.startedAt > 60_000) throw new Error(`Startup has not registered after 60 seconds in ${name}; inspect preserved ${role.slice(1)}.log.`);
        return 'pending';
      }
    }
    writeFileSync(claimPath, JSON.stringify({ name, startedAt: Date.now() }), { mode: 0o600 });
    if (live) {
      // A dead pane's old pipe may have closed. Append directly on respawn.
      const command = [process.execPath, cli, 'loop', role, dir].map(shellQuote).join(' ');
      const result = await boundary.command('tmux', ['respawn-pane', '-t', `${name}:0.0`, '-c', state.cwd,
        `exec ${command} >> ${shellQuote(join(dir, `${role.slice(1)}.log`))} 2>&1`]);
      if (result.code) throw new Error(result.stderr);
    } else await boundary.start({ name, cwd: state.cwd, command: [process.execPath, cli, 'loop', role, dir], logPath: join(dir, `${role.slice(1)}.log`) });
    return 'started';
  } finally { release(); }
}

export async function launchRun(dir: string, waitForWork = true, runtime: { commands?: HostCommands; startupMs?: number; assess?: typeof supervisoryAssessment } = {}): Promise<void> {
  const state = stateOf(dir);
  if (state.stopRequested || ['DRAFT', 'PAUSED', 'BUDGET_EXHAUSTED', 'READY_FOR_REVIEW', 'COMPLETE'].includes(state.status)) throw new Error(`Cannot launch ${state.status}; approve or explicitly resume first.`);
  if (ownsProcess(state.host)) throw new Error(`Controller already running with pid ${state.host!.pid}.`);
  const surviving = state.invocations.filter(i => !i.endedAt && i.pid && processSignature(i.pid));
  if (surviving.length) throw new Error('Surviving workers still own assignments; wait for reconciliation before resume.');
  if (!ownsProcess(state.monitor)) await startPane(dir, `wan-${state.id}-monitor`, '_monitor', runtime.commands);
  await startPane(dir, `wan-${state.id}`, '_controller', runtime.commands);
  console.log(`Run: ${state.id}\nAttach: tmux attach -t wan-${state.id}\nState: ${dir}`);
  if (!waitForWork) return;
  const startupMs = runtime.startupMs ?? 60_000;
  const deadline = Date.now() + startupMs;
  while (Date.now() < deadline) {
    const current = stateOf(dir);
    if (current.status === 'PAUSED' || current.status === 'BUDGET_EXHAUSTED') throw new Error(`Startup stopped: ${current.events.at(-1)?.detail}`);
    if (current.events.some(e => ['checkpoint', 'integration', 'ready'].includes(e.type))) {
      console.log(`Useful checkpoint confirmed. Progress: ${current.dashboard?.url ?? join(dir, 'progress.html')}`); return;
    }
    // Observe real source changes as useful work even before the first short turn ends.
    for (const task of current.plan.tasks.filter(t => t.workspace && t.status === 'running')) {
      if (current.kind === 'code') {
        const diff = await runCommand('git', ['status', '--porcelain'], { cwd: task.workspace });
        if (diff.stdout.trim()) { console.log(`Source changes confirmed for ${task.id}. Progress: ${current.dashboard?.url ?? join(dir, 'progress.html')}`); return; }
      }
    }
    await sleep(1000);
  }
  const current = stateOf(dir);
  const diagnosis = `No useful work confirmed within ${startupMs / 1000} seconds. Controller ${ownsProcess(current.host) ? 'registered' : 'not registered'}; ${current.invocations.filter(i => !i.endedAt).length} active invocations. Logs preserved in ${dir}.`;
  mutate(dir, s => { event(s, 'startup-no-work', diagnosis); });
  try { await (runtime.assess ?? supervisoryAssessment)(dir); }
  catch (error) { mutate(dir, s => event(s, 'startup-diagnosis-error', String(error))); }
  throw new Error(diagnosis);
}

export async function monitor(dir: string, options: { assess?: typeof supervisoryAssessment } = {}): Promise<void> {
  const release = mutate(dir, () => acquireLease(dir, 'monitor'));
  let server: Awaited<ReturnType<typeof serveDashboard>> | undefined;
  let running = true;
  let wake: (() => void) | undefined;
  const stop = () => { running = false; wake?.(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  // Process health is inspected immediately; the first agent assessment follows
  // the configured interval so supervision does not occupy the startup slot.
  let lastAssessment = Date.now();
  let keepAwake: ReturnType<typeof spawn> | undefined;
  try {
    server = await serveDashboard(dir);
    mutate(dir, s => { s.monitor = { hostId: hostId(), pid: process.pid, signature: processSignature(process.pid), heartbeat: Date.now() }; });
    if (stateOf(dir).settings.keepAwake) {
      if (process.platform === 'darwin') keepAwake = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      else if (process.platform === 'linux') keepAwake = spawn('systemd-inhibit', ['--what=sleep', '--why=Authorized wan loop run', '--mode=block', 'sleep', 'infinity'], { stdio: 'ignore' });
      keepAwake?.on('error', error => mutate(dir, s => event(s, 'keep-awake-error', error.message)));
    }
    while (running) {
      mutate(dir, s => { if (s.monitor) s.monitor.heartbeat = Date.now(); });
      const state = stateOf(dir);
      if (['READY_FOR_REVIEW', 'COMPLETE'].includes(state.status)) {
        await recordProgress(dir);
        break; // Terminal progress remains available in preserved progress.html.
      }
      await inspectRun(dir);
      const current = stateOf(dir);
      if (['PAUSED', 'BUDGET_EXHAUSTED'].includes(current.status)) {
        // Dashboard remains accessible, but no agent-based supervision spends budget.
        keepAwake?.kill(); keepAwake = undefined;
      } else if (!ownsProcess(current.host) && !current.stopRequested && current.approvedHash && !current.invocations.some(i => !i.endedAt && i.pid && processSignature(i.pid))) {
        try {
          const launched = await startPane(dir, `wan-${current.id}`, '_controller');
          if (launched === 'started') mutate(dir, s => event(s, 'controller-recovery', 'Restarted controller after ownership reconciliation.'));
        } catch (error) { mutate(dir, s => { s.status = 'PAUSED'; event(s, 'recovery-error', String(error)); }); }
      }
      if (running && !current.stopRequested && !['PAUSED', 'BUDGET_EXHAUSTED', 'READY_FOR_REVIEW', 'COMPLETE'].includes(current.status) && Date.now() - lastAssessment >= current.settings.monitorMs) {
        lastAssessment = Date.now();
        try { await (options.assess ?? supervisoryAssessment)(dir); }
        catch (error) { mutate(dir, s => event(s, 'supervisor-error', String(error))); }
      }
      await recordProgress(dir);
      if (running) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 10_000); wake = () => { clearTimeout(timer); resolve(); }; });
    }
  } finally {
    keepAwake?.kill(); server?.close();
    try { mutate(dir, s => { if (s.monitor?.pid === process.pid) { s.monitor = undefined; s.dashboard = undefined; } }); }
    finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); release(); }
  }
}

export async function hostService(root: string): Promise<void> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const release = acquireLease(root, 'host-service');
  let running = true;
  let wake: (() => void) | undefined;
  const stop = () => { running = false; wake?.(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    while (running) {
      for (const id of readdirSync(root)) {
        const dir = join(root, id);
        if (!existsSync(join(dir, 'state.json'))) continue;
        try {
          const state = stateOf(dir);
          if (!state.approvedHash || state.stopRequested || ['DRAFT', 'PAUSED', 'BUDGET_EXHAUSTED', 'READY_FOR_REVIEW', 'COMPLETE'].includes(state.status)) continue;
          await inspectRun(dir);
          if (!ownsProcess(stateOf(dir).monitor)) await startPane(dir, `wan-${state.id}-monitor`, '_monitor');
        } catch (error) { console.error(`Recovery ${id}: ${String(error)}`); }
      }
      if (running) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 10_000); wake = () => { clearTimeout(timer); resolve(); }; });
    }
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); release(); }
}

export async function installService(root: string, install: boolean): Promise<void> {
  const definition = serviceDefinition({ name: 'loop-supervisor', cwd: root, command: [process.execPath, cli, 'loop', '_host', root], logPath: join(root, 'host.log') });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!install) { console.log(definition.content); console.log(`\nInstall path: ${definition.path}\n${definition.install.join('\n')}\nRequires an active user login; Linux boot without login requires administrator-configured lingering.`); return; }
  mkdirSync(dirname(definition.path), { recursive: true });
  if (existsSync(definition.path) && readFileSync(definition.path, 'utf8') !== definition.content) throw new Error(`Service already exists with different configuration: ${definition.path}`);
  writeFileSync(definition.path, definition.content, { mode: 0o600 });
  for (const command of definition.install) {
    const result = await runCommand('/bin/sh', ['-c', command]);
    if (result.code) throw new Error(result.stderr);
  }
  console.log(`Installed opt-in host recovery: ${definition.path}. It resumes authorized runs after user login; it cannot run while the host is asleep or powered off.`);
}
