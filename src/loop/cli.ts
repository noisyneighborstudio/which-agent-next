import { readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRun, initializeRun, approveRun, extendBudget, assertApproved, reconcileInvocations, type Plan } from './state.js';
import { DEFAULT_SETTINGS, duration, seedPlan, type LoopState } from './protocol.js';
import { controller, stateOf, mutate, event } from './engine.js';
import { interview, askBudget, applyPlanFile } from './interview.js';
import { gitRevision, createWorktree, integrateWorktree, runCommand, processAlive } from './runtime.js';
import { copyArtifacts } from './artifacts.js';
import { ownsProcess } from './ownership.js';
import { launchRun, monitor, hostService, installService } from './host.js';
import { progressText, serveDashboard } from './progress.js';

export const LOOP_HELP = `wan loop — pursue the complete approved goal with independent verification.

  wan loop "goal" --budget 2h        interview, approve, and start
  wan loop start --file goal.md --budget 2h
  wan loop start --plan plan.json --approve --host-limits-accepted
  wan loop plan "goal" --budget 2h   draft and interview without launching
  wan loop approve <run> --plan plan.json --approve --host-limits-accepted
  wan loop status [run] [--json]     inspect evidence, obligations, and budget
  wan loop attach <run>             attach to the controller tmux session
  wan loop stop <run>               request a graceful checkpoint and stop
  wan loop resume <run>             reconcile and resume approved work
  wan loop extend <run> --budget 4h  explicitly approve a new total budget
  wan loop dashboard <run>          serve read-only progress on loopback
  wan loop service [--install]      preview or install opt-in host recovery

Options:
  --cwd <directory>      input workspace (default current directory)
  --kind code|artifact  override automatic Git repository detection
  --file <path>         append source instructions; repeatable
  --plan <path>         explicit JSON plan with criteria, tasks, and budgetMs
  --budget <duration>   total aggregate agent time, such as 30m or 2h
  --root <directory>    durable runs directory (default user state directory)
  --concurrency <n>     simultaneous workers, 1–8 (default 2)
  --keep-awake          authorize host sleep inhibition while running
  --approve             approve a supplied plan without interactive questions
  --host-limits-accepted acknowledge that sleep/power loss stops execution

All agent roles consume the shared budget. Waiting for quota and external jobs
does not. Each invocation is capped at five minutes. Allocation renewals remain
within your overall budget. No merge, deployment, publication, or extra capacity
purchase is authorized by default. A plan can explicitly allow github:pr to
maintain a bot-authored PR and progress comment.

tmux survives disconnection, not sleep or reboot. The optional user host service
recovers after login. Remote dashboard access requires your secure connection.
`;

interface Args { command: string; positional: string[]; files: string[]; plan?: string; budget?: number; root: string; cwd: string; kind?: 'code' | 'artifact'; concurrency: number; approve: boolean; hostLimits: boolean; keepAwake: boolean; json: boolean; install: boolean }
export function parseLoopArgs(argv: string[]): Args {
  const root = process.env.WAN_LOOP_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'which-agent-next', 'loops');
  const commands = new Set(['start', 'plan', 'approve', 'status', 'attach', 'stop', 'resume', 'extend', 'dashboard', 'service', '_controller', '_monitor', '_host']);
  const first = argv[0];
  const command = commands.has(first) ? first : 'start';
  const values = commands.has(first) ? argv.slice(1) : argv;
  const args: Args = { command, positional: [], files: [], root: resolve(root), cwd: process.cwd(), concurrency: 2, approve: false, hostLimits: false, keepAwake: false, json: false, install: false };
  const need = (index: number, flag: string): string => { const next = values[index + 1]; if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value.`); return next; };
  for (let i = 0; i < values.length; i++) {
    switch (values[i]) {
      case '--file': args.files.push(resolve(need(i++, '--file'))); break;
      case '--plan': args.plan = resolve(need(i++, '--plan')); break;
      case '--budget': args.budget = duration(need(i++, '--budget')); break;
      case '--root': args.root = resolve(need(i++, '--root')); break;
      case '--cwd': args.cwd = resolve(need(i++, '--cwd')); break;
      case '--kind': { const kind = need(i++, '--kind'); if (kind !== 'code' && kind !== 'artifact') throw new Error('Kind must be code or artifact.'); args.kind = kind; break; }
      case '--concurrency': args.concurrency = Number(need(i++, '--concurrency')); break;
      case '--approve': args.approve = true; break;
      case '--host-limits-accepted': args.hostLimits = true; break;
      case '--keep-awake': args.keepAwake = true; break;
      case '--json': args.json = true; break;
      case '--install': args.install = true; break;
      case '--': args.positional.push(...values.slice(i + 1)); i = values.length; break;
      default: if (values[i].startsWith('-')) throw new Error(`Unknown loop option: ${values[i]}`); else args.positional.push(values[i]);
    }
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) throw new Error('Concurrency must be an integer from 1 to 8.');
  return args;
}

function runDirectory(args: Args): string {
  const input = args.positional[0];
  if (input) {
    if (isAbsolute(input)) return resolve(input);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input)) throw new Error('Use a run ID or an absolute run directory.');
    return join(args.root, input);
  }
  if (!existsSync(args.root)) throw new Error('No runs exist.');
  const runs = readdirSync(args.root).map(id => join(args.root, id)).filter(dir => existsSync(join(dir, 'state.json')));
  if (runs.length !== 1) throw new Error('Specify the run ID. Available runs: ' + runs.map(dir => stateOf(dir).id).join(', '));
  return runs[0];
}

export async function prepareWorkspace(dir: string, git = { gitRevision, createWorktree, integrateWorktree, runCommand }): Promise<void> {
  const state = stateOf(dir);
  if (state.git || state.answers.workspacePrepared) return;
  if (state.kind === 'code') {
    const dirty = await git.runCommand('git', ['status', '--porcelain'], { cwd: state.cwd });
    if (dirty.code) throw new Error(dirty.stderr || 'Could not inspect the input repository.');
    const base = await git.gitRevision(state.cwd), branch = `wan/loop-${state.id}`, cwd = join(dir, 'integration');
    await git.createWorktree(state.cwd, cwd, branch, base);
    // Snapshot staged, unstaged and non-ignored untracked inputs only in the
    // isolated branch. The user's checkout and index remain untouched.
    const snapshot = dirty.stdout.trim()
      ? (await git.integrateWorktree(cwd, state.cwd, base, ['**'])).revision
      : base;
    mutate(dir, s => { s.cwd = cwd; s.git = { base, branch, remote: 'origin' }; s.answers.workspacePrepared = 'yes'; event(s, 'workspace', `Isolated worktree ${cwd} at ${snapshot}; original checkout preserved`); });
  } else {
    const cwd = join(dir, 'deliverables');
    copyArtifacts(state.cwd, cwd);
    mutate(dir, s => { s.cwd = cwd; s.answers.workspacePrepared = 'yes'; event(s, 'workspace', `Isolated deliverables ${cwd}`); });
  }
}

export async function loopMain(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(LOOP_HELP); return; }
  const args = parseLoopArgs(argv);
  if (args.command === '_controller') { await controller(resolve(args.positional[0])); return; }
  if (args.command === '_monitor') { await monitor(resolve(args.positional[0])); return; }
  if (args.command === '_host') { await hostService(resolve(args.positional[0])); return; }
  if (args.command === 'service') { await installService(args.root, args.install); return; }
  if (args.command === 'start' || args.command === 'plan') {
    const supplied = args.plan ? JSON.parse(readFileSync(args.plan, 'utf8')) as Plan : undefined;
    if (args.approve && !supplied) throw new Error('--approve requires an explicit --plan file. Goals need a drafted and reviewed plan.');
    if (args.approve && !args.hostLimits) throw new Error('Unattended start needs --host-limits-accepted.');
    const goal = [args.positional.join(' '), ...args.files.map(path => `Instructions from ${path}:\n${readFileSync(path, 'utf8')}`)].filter(Boolean).join('\n\n') || supplied?.goal;
    if (!goal) throw new Error('Supply a goal, --file, or --plan.');
    const budget = args.budget ?? supplied?.budgetMs ?? await askBudget();
    if (supplied && supplied.budgetMs !== budget) throw new Error('--budget differs from the supplied plan budget. Update the plan explicitly.');
    const git = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: args.cwd });
    const kind = args.kind ?? (git.code === 0 && git.stdout.trim() === 'true' ? 'code' : 'artifact');
    const id = randomUUID(), dir = join(args.root, id);
    if (resolve(args.root) === args.cwd || resolve(args.root).startsWith(args.cwd + '/')) throw new Error('Keep --root outside the input workspace so run metadata is never copied into deliverables.');
    const state: LoopState = { ...createRun({ id, cwd: args.cwd, kind, plan: supplied ?? seedPlan(goal, budget) }),
      settings: { ...DEFAULT_SETTINGS, concurrency: args.concurrency, keepAwake: args.keepAwake }, jobs: [], questions: [], answers: args.hostLimits ? { hostLimits: 'Acknowledged explicitly' } : {}, failedProviders: {} };
    initializeRun(dir, state);
    console.log(`Draft saved: ${id}\n${dir}`);
    if (args.approve) mutate(dir, s => approveRun(s));
    else await interview(dir, !!supplied);
    if (args.command === 'plan') { console.log(`Approved plan saved; execution has not started. Use wan loop resume ${id}.`); return; }
    await prepareWorkspace(dir); await launchRun(dir); return;
  }
  const dir = runDirectory(args);
  switch (args.command) {
    case 'status': console.log(args.json ? JSON.stringify(stateOf(dir), null, 2) : progressText(stateOf(dir))); return;
    case 'approve': {
      if (args.plan) applyPlanFile(dir, args.plan);
      if (args.approve) {
        if (!args.plan || !args.hostLimits) throw new Error('Explicit approval requires --plan and --host-limits-accepted.');
        mutate(dir, s => { if (s.questions.some(q => !(q.id in s.answers))) throw new Error('Unanswered material questions remain.'); s.answers.hostLimits = 'Acknowledged explicitly'; approveRun(s); });
      } else await interview(dir, !!args.plan);
      console.log(`Plan approved. Start with wan loop resume ${stateOf(dir).id}.`); return;
    }
    case 'extend': {
      if (!args.budget) throw new Error('Use --budget for the explicitly approved new total budget.');
      mutate(dir, s => extendBudget(s, args.budget!));
      console.log(`Total budget is now ${args.budget / 60_000} agent minutes; cumulative usage preserved. Resume explicitly if paused.`); return;
    }
    case 'stop': mutate(dir, s => { s.stopRequested = true; event(s, 'stop-requested', 'User requested graceful stop.'); }); console.log('Stop requested. Active agents will checkpoint or be cancelled; partial work is preserved.'); return;
    case 'resume': {
      const current = stateOf(dir);
      if (current.status === 'DRAFT') await interview(dir);
      mutate(dir, s => {
        assertApproved(s);
        if (ownsProcess(s.host) || s.invocations.some(i => !i.endedAt && i.pid && processAlive(i.pid))) throw new Error('A surviving controller or worker still owns this run.');
        if (['READY_FOR_REVIEW', 'COMPLETE'].includes(s.status)) throw new Error('Run already finished.');
        reconcileInvocations(s, processAlive);
        if (s.budget.usedMs >= s.budget.limitMs) throw new Error('Overall budget exhausted. Explicitly extend it before resuming.');
        s.stopRequested = false; s.status = 'APPROVED'; event(s, 'resume', 'User resumed existing approved scope and cumulative budget.');
      });
      await prepareWorkspace(dir); await launchRun(dir); return;
    }
    case 'attach': {
      const child = spawn('tmux', ['attach-session', '-t', `wan-${stateOf(dir).id}`], { stdio: 'inherit' });
      await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`tmux attach exited ${code}`))); }); return;
    }
    case 'dashboard': {
      const server = await serveDashboard(dir);
      console.log(`Progress: ${stateOf(dir).dashboard!.url}\nRead-only loopback listener; use your configured secure tunnel for remote access.`);
      const stop = () => server.close(); process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
    }
  }
}
