/**
 * Runtime primitives for the wan loop: pick an agent, run it non-interactively
 * under a hard leash, read a structured report back, and move its work into a
 * target tree only after an explicit ownership check.
 *
 * Standalone by design — nothing here imports loop state. The only internal
 * dependencies are `decide`/`rank`/config from the wan core and `shellQuote`.
 *
 * Two rules run through the whole file. Nothing is claimed that has not been
 * checked against the installed tool (adapter flags are verified against
 * `--help`, never assumed), and nothing that writes runs under a human's git
 * identity.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, createWriteStream, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, readlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { decide, loadConfig } from "../index.js";
import { agentId } from "../rank.js";
import type { Candidate, Config } from "../types.js";
import { shellQuote } from "../util.js";

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when output hit the capture cap, so `stdout` is not the whole story. */
  truncated?: boolean;
}

/**
 * Cap on captured output. Deliberately larger than `MAX_PATCH_BYTES` so an
 * oversized patch trips its own explicit limit rather than arriving here
 * quietly shortened — a truncated patch that still applies is the worst
 * possible outcome.
 */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/** Injectable spawner. Tests substitute this instead of reaching for env vars. */
export type CommandRunner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

/** Nothing may run longer than this, whatever the caller asks for. */
export const MAX_TIMEOUT_MS = 5 * 60_000;
/** The point the prompt should target for a self-checkpoint. */
export const SOFT_CHECKPOINT_MS = 3 * 60_000;
/** Longest gap we will leave between SIGTERM and SIGKILL of a process group. */
export const KILL_GRACE_MS = 5_000;

export const runCommand: CommandRunner = (command, args, options = {}) => {
  const timeoutMs = Math.min(options.timeoutMs ?? 60_000, MAX_TIMEOUT_MS);
  return new Promise((res, rej) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? childEnv(),
      shell: false, // no shell: argv is argv, never a string to be re-parsed
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    child.stdout?.on("data", (c) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += c;
      else truncated = true;
    });
    child.stderr?.on("data", (c) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += c;
      else truncated = true;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }, timeoutMs);
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input ?? "");
    child.once("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      res({ code: code ?? -1, stdout, stderr, truncated });
    });
  });
};

// ---------------------------------------------------------------------------
// Provider command parsing
// ---------------------------------------------------------------------------

/**
 * Characters that only mean something to a shell. We never run a shell, so a
 * command containing one of these would be silently mis-executed — refuse it
 * instead. Quoted occurrences are fine and come back as literal text.
 */
const SHELL_METACHARS = new Set(["|", "&", ";", "<", ">", "(", ")", "$", "`", "*", "?", "[", "]", "{", "}", "\n", "\r"]);

/**
 * Split a configured provider command into argv the way a POSIX shell would
 * *tokenise* it — quotes and backslashes only, no expansion of any kind.
 * Existing config carries quoted paths (`'/Users/a b/bin/claude' --profile x`)
 * so a naive `split(" ")` breaks them; anything needing real shell semantics
 * is rejected rather than approximated.
 */
export function splitCommand(command: string): string[] {
  if (typeof command !== "string" || !command.trim()) throw new Error("provider command is empty");
  const tokens: string[] = [];
  let cur = "";
  let started = false;
  let i = 0;

  const flush = () => {
    if (started) tokens.push(cur);
    cur = "";
    started = false;
  };
  const bad = (why: string) => new Error(`unsupported shell syntax in provider command ${JSON.stringify(command)}: ${why}`);

  while (i < command.length) {
    const ch = command[i]!;
    if (ch === " " || ch === "\t") {
      flush();
      i++;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw bad("unterminated single quote");
      cur += command.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < command.length) {
        const c = command[i]!;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === "\\") {
          const next = command[i + 1];
          if (next === undefined) throw bad("trailing backslash");
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            cur += next;
            i += 2;
            continue;
          }
          cur += c;
          i++;
          continue;
        }
        if (c === "$" || c === "`") throw bad(`${c} expansion inside double quotes`);
        cur += c;
        i++;
      }
      if (!closed) throw bad("unterminated double quote");
      started = true;
      continue;
    }
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined) throw bad("trailing backslash");
      cur += next;
      started = true;
      i += 2;
      continue;
    }
    if (SHELL_METACHARS.has(ch)) throw bad(`unquoted ${JSON.stringify(ch)}`);
    if (ch === "~" && !started) throw bad("unquoted ~ (no shell runs, so it would never expand)");
    cur += ch;
    started = true;
    i++;
  }
  flush();
  if (!tokens.length) throw new Error("provider command is empty");
  return tokens;
}

// ---------------------------------------------------------------------------
// Roles and provider adapters
// ---------------------------------------------------------------------------

/**
 * Every role the controller can invoke. `worker` is the only one allowed to
 * touch the workspace; a planner produces a plan and a coordinator inspects
 * and decides, and neither can implement anything even if it wanted to.
 */
export const ROLES = ["worker", "planner", "verifier", "coordinator", "supervisor"] as const;
export type AgentRole = (typeof ROLES)[number];

/** Roles that may write to the workspace. Everything else runs read-only. */
export const WRITE_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["worker"]);

export function isRole(role: string): role is AgentRole {
  return (ROLES as readonly string[]).includes(role);
}

export function asRole(role: string): AgentRole {
  if (!isRole(role)) throw new Error(`unknown role "${role}" (known: ${ROLES.join(", ")})`);
  return role;
}

export function isWriteRole(role: string): boolean {
  return WRITE_ROLES.has(role as AgentRole);
}

export interface Provider {
  id: string;
  cli: string;
  command: string;
  profile?: string;
}

interface Adapter {
  cli: string;
  /** Roles supported by this CLI invocation. */
  roles: ReadonlySet<AgentRole>;
  /** Argv after the command itself, for a given role. */
  args(role: AgentRole): string[];
  /** Flag that reads the prompt from a file. Absent means the prompt goes on stdin. */
  promptFlag?: string;
  /** Argv that prints the help page covering `args(role)`. */
  helpArgs(role: AgentRole): string[];
  /** Flags `args()` relies on. Absent from `--help` means we refuse to run. */
  requiredFlags(role: AgentRole): string[];
  /** Why an unsupported role is unsupported — never a guess at a flag. */
  unsupported(role: string): string;
}

const ADAPTERS: Adapter[] = [
  {
    cli: "claude",
    roles: new Set<AgentRole>(ROLES),
    // The provider's model reviews permissions. Roles remain prompt contracts;
    // wan does not replace the provider's tools, MCP configuration, or policy.
    args: () => ["-p", "--output-format", "text", "--permission-mode", "auto"],
    helpArgs: () => ["--help"],
    requiredFlags: () => ["-p", "--output-format", "--permission-mode"],
    unsupported: (role) => `claude has no configured argv for role "${role}"`,
  },
  {
    cli: "codex",
    roles: new Set<AgentRole>(ROLES),
    // Codex handles approval review and its sandbox through its native mode.
    args: () => ["exec", "--color", "never", "--approve-for-me", "-"],
    helpArgs: () => ["exec", "--help"],
    requiredFlags: () => ["--approve-for-me", "--color"],
    unsupported: (role) => `codex has no configured argv for role "${role}"`,
  },
  {
    cli: "opencode",
    // Keep opencode's own configured permission handling for every role.
    roles: new Set<AgentRole>(ROLES),
    args: () => ["run"],
    helpArgs: () => ["run", "--help"],
    requiredFlags: () => [],
    unsupported: (role) => `opencode has no configured invocation for role "${role}"`,
  },
  {
    cli: "muse",
    roles: new Set<AgentRole>(ROLES),
    // Its LLM approval judge reviews tool calls; the sandbox stays on. Nobody
    // is there to answer a question, so those are cancelled, not left hanging.
    args: () => ["exec", "--approval-judge", "on", "--user-input-auto-resolve"],
    promptFlag: "--prompt-file",
    helpArgs: () => ["exec", "--help"],
    requiredFlags: () => ["--approval-judge", "--user-input-auto-resolve", "--prompt-file"],
    unsupported: (role) => `muse has no configured argv for role "${role}"`,
  },
  {
    cli: "gemini",
    // Its non-interactive mode offers --yolo (all writes) or interactive
    // approval that nobody is present to give. Neither is a role we can run.
    roles: new Set<AgentRole>(),
    args: () => [],
    helpArgs: () => ["--help"],
    requiredFlags: () => [],
    unsupported: (role) =>
      `gemini cannot run role "${role}": its non-interactive mode offers no verified scoped approval flag, only --yolo, which is not allowed`,
  },
];

export const SUPPORTED_CLIS: readonly string[] = ADAPTERS.map((a) => a.cli);

export function adapterFor(cli: string): Adapter | undefined {
  return ADAPTERS.find((a) => a.cli === cli);
}

/** Roles supported by the configured provider invocation. */
export function supportedRoles(cli: string): AgentRole[] {
  const roles = adapterFor(cli)?.roles;
  return roles ? ROLES.filter((r) => roles.has(r)) : [];
}

/** Why `cli` cannot serve `role`, or undefined when it can. */
export function unsupportedReason(cli: string, role: string): string | undefined {
  const adapter = adapterFor(cli);
  if (!adapter) return `${cli} is not a supported adapter (supported: ${SUPPORTED_CLIS.join(", ")})`;
  if (!isRole(role)) return `unknown role "${role}" (known: ${ROLES.join(", ")})`;
  return adapter.roles.has(role) ? undefined : adapter.unsupported(role);
}

// --- flag verification ------------------------------------------------------

const FLAG_CACHE = new Map<string, Promise<Set<string>>>();
const FLAG_RE = /(?<![\w-])(--?[A-Za-z0-9][A-Za-z0-9-]*)/g;

/** Every flag the installed build advertises on the given help page. */
export async function helpFlags(command: string, helpArgs: string[], run: CommandRunner = runCommand): Promise<Set<string>> {
  const argv = splitCommand(command);
  const key = `${argv.join("\u0000")}\u0001${helpArgs.join("\u0000")}`;
  const cached = FLAG_CACHE.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const r = await run(argv[0]!, [...argv.slice(1), ...helpArgs], { timeoutMs: 30_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    const flags = new Set<string>();
    for (let m = FLAG_RE.exec(text); m; m = FLAG_RE.exec(text)) flags.add(m[1]!);
    FLAG_RE.lastIndex = 0;
    return flags;
  })();
  FLAG_CACHE.set(key, pending);
  return pending.catch((e) => {
    FLAG_CACHE.delete(key);
    throw e;
  });
}

/** Drop the memoised `--help` reads. Exposed so tests aren't order-dependent. */
export function resetFlagCache(): void {
  FLAG_CACHE.clear();
}

/**
 * Verify that the installed CLI accepts our invocation options. Tool approval
 * decisions remain with the provider's native approval mode.
 */
export async function assertAdapterFlags(provider: Provider, role: AgentRole, run: CommandRunner = runCommand): Promise<void> {
  const adapter = adapterFor(provider.cli);
  if (!adapter) throw new Error(`${provider.cli} is not a supported adapter`);
  const required = adapter.requiredFlags(role);
  if (!required.length) return;

  let advertised: Set<string>;
  try {
    advertised = await helpFlags(provider.command, adapter.helpArgs(role), run);
  } catch (e) {
    throw new Error(`cannot verify ${provider.cli} flags for role "${role}": ${(e as Error).message}`);
  }
  const missing = required.filter((f) => !advertised.has(f));
  if (missing.length) {
    throw new Error(
      `refusing to run ${provider.cli} as "${role}": the installed build does not advertise ${missing.join(", ")} ` +
        `(checked \`${provider.command} ${adapter.helpArgs(role).join(" ")}\`)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

export interface SelectOptions {
  /** CLI keys or candidate ids to drop, on top of config `exclude`. */
  exclude?: string[];
  /** Prefer a provider not in this list, but only among comparable picks. */
  preferDifferentFrom?: string[];
  /** Restrict to these CLI keys or ids. */
  only?: string[];
  /** Filter to providers that can run this role safely. */
  role?: string;
  /** Injected for tests — defaults to the real quota decision. */
  decider?: (config: Config) => Promise<{ ranked: RankedLike[] }>;
  config?: Partial<Config>;
  now?: number;
}

/** The shape of `rank()` output we actually depend on. */
export interface RankedLike extends Candidate {
  tier: string;
  eligible: boolean;
}

export interface Selection {
  provider?: Provider;
  /** Epoch ms at which a *relevant* candidate is expected to free up. */
  retryAt?: number;
  reason: string;
}

const TIER_ORDER = ["plenty", "ok", "unknown", "low", "local", "exhausted"];

function toProvider(c: Candidate): Provider {
  return { id: agentId(c), cli: c.cli, command: c.command, profile: c.profile };
}

function matches(c: Candidate, keys: string[]): boolean {
  return keys.includes(c.cli) || keys.includes(c.id) || keys.includes(agentId(c));
}

/** States that mean "this CLI would work if it had quota". */
function authenticated(c: Candidate): boolean {
  return c.state === "ready" || c.state === "unknown" || c.state === "unmetered";
}

export interface RetryOptions {
  /** Headroom below which a window counts as blocking. */
  minHeadroom?: number;
  now?: number;
}

/**
 * When a *relevant* candidate is next expected to become usable.
 *
 * The subtlety this exists for: a candidate whose 5h window resets in twenty
 * minutes but whose weekly window is also spent is not usable in twenty
 * minutes. So a candidate's retry point is the **latest** of its blocking
 * windows, and the answer is the **earliest** of those per-candidate points.
 * Candidates that cannot be used at all — unauthenticated, errored, excluded,
 * or unable to run the role — contribute nothing: their reset times are not
 * deadlines for us. A blocking window with no known reset makes its candidate
 * unpredictable, so that candidate is dropped rather than guessed at.
 */
export function nextRetryAt(candidates: Candidate[], options: RetryOptions = {}): number | undefined {
  const now = options.now ?? Date.now();
  const threshold = 100 - (options.minHeadroom ?? 0);
  const perCandidate: number[] = [];

  for (const c of candidates) {
    if (!authenticated(c)) continue;
    const blocking = c.windows.filter((w) => w.usedPercent >= threshold);
    if (!blocking.length) continue; // not quota-blocked; it is out for another reason
    const resets = blocking.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN));
    if (resets.some((t) => !Number.isFinite(t) || t <= now)) continue; // unknowable
    perCandidate.push(Math.max(...resets));
  }
  return perCandidate.length ? Math.min(...perCandidate) : undefined;
}

export async function selectProvider(options: SelectOptions = {}): Promise<Selection> {
  const config = loadConfig(options.config ?? {});
  const decider = options.decider ?? ((cfg: Config) => decide(cfg) as Promise<{ ranked: RankedLike[] }>);
  const { ranked } = await decider(config);
  const role = options.role === undefined ? undefined : asRole(options.role);

  const dropped: string[] = [];
  /** Candidates that pass every filter except quota — the only relevant pool. */
  const relevant = ranked.filter((c) => {
    if (options.exclude?.length && matches(c, options.exclude)) return false;
    if (options.only?.length && !matches(c, options.only)) return false;
    const why = unsupportedReason(c.cli, role ?? "worker");
    if (role === undefined) {
      // No role asked for: only adapter support matters.
      if (!adapterFor(c.cli)) {
        dropped.push(`${c.cli} is not a supported adapter (supported: ${SUPPORTED_CLIS.join(", ")})`);
        return false;
      }
      return true;
    }
    if (why) {
      dropped.push(why);
      return false;
    }
    return true;
  });

  const eligible = relevant.filter((c) => c.eligible);

  if (!eligible.length) {
    const retryAt = nextRetryAt(relevant, { minHeadroom: config.minHeadroom, now: options.now });
    const why = dropped.length
      ? `no usable provider: ${[...new Set(dropped)].join("; ")}`
      : "no usable provider: every candidate is exhausted, unauthenticated, or excluded";
    return {
      retryAt,
      reason: retryAt ? `${why}; earliest relevant window reset ${new Date(retryAt).toISOString()}` : why,
    };
  }

  const best = eligible[0]!;
  // Diversity only matters among picks of the same standing. Rotating onto a
  // materially weaker agent just to be different burns the good quota later.
  const avoid = options.preferDifferentFrom ?? [];
  const comparable = eligible.filter((c) => TIER_ORDER.indexOf(c.tier) === TIER_ORDER.indexOf(best.tier));
  const diverse = comparable.find((c) => !matches(c, avoid));

  if (avoid.length && diverse && diverse.id !== best.id) {
    return {
      provider: toProvider(diverse),
      reason: `${diverse.label}: rotated off ${avoid.join(", ")} at equal standing (${diverse.tier})`,
    };
  }
  if (avoid.length && !diverse) {
    return {
      provider: toProvider(best),
      reason: `${best.label}: no equally-strong alternative to ${avoid.join(", ")}, reusing it`,
    };
  }
  return { provider: toProvider(best), reason: `${best.label}: ${best.tier}${best.headroom !== undefined ? `, ${best.headroom}% headroom` : ""}` };
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = 128 * 1024;

export interface AgentRequest {
  provider: Provider;
  cwd: string;
  prompt: string;
  logPath: string;
  /** Finite, positive, and clamped to MAX_TIMEOUT_MS including the kill grace. */
  timeoutMs: number;
  role: string;
  signal?: AbortSignal;
  /** Fired synchronously with the pid, before anything can await. */
  onSpawn?: (pid: number) => void;
  /**
   * Fired once the child's birth signature has been read, if ever. Persist it:
   * `terminateOwnedProcess` requires it to kill across process restarts.
   */
  onSignature?: (pid: number, signature: string) => void;
  /** Fired once when the soft checkpoint deadline passes; the child is not signalled. */
  onSoftCheckpoint?: () => void;
  env?: Record<string, string | undefined>;
  /** Skip the `--help` flag audit. Only for tests with fixture CLIs. */
  verifyFlags?: boolean;
  run?: CommandRunner;
}

export interface AgentResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  elapsedMs: number;
  text: string;
  pid?: number;
  /** Birth signature, when it could be read while the child was alive. */
  signature?: string;
  aborted?: boolean;
  /** True when the run outlived the soft checkpoint deadline. */
  softCheckpointPassed?: boolean;
  /** True when `text` had a middle section elided to bound memory. */
  truncated?: boolean;
  logPath?: string;
}

/**
 * Bounded capture that keeps both ends. The head carries the agent's plan and
 * the tail carries its WAN_RESULT; only the middle is ever dropped.
 */
class BoundedOutput {
  private head = Buffer.alloc(0);
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = 0;

  push(chunk: Buffer): void {
    if (this.head.length < HEAD_BYTES) {
      const take = Math.min(HEAD_BYTES - this.head.length, chunk.length);
      this.head = Buffer.concat([this.head, chunk.subarray(0, take)]);
      chunk = chunk.subarray(take);
      if (!chunk.length) return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > TAIL_BYTES && this.tail.length > 1) {
      const first = this.tail.shift()!;
      this.tailBytes -= first.length;
      this.dropped += first.length;
    }
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  text(): string {
    const tail = Buffer.concat(this.tail);
    if (!this.dropped) return Buffer.concat([this.head, tail]).toString("utf8");
    return `${this.head.toString("utf8")}\n…[${this.dropped} bytes elided]…\n${tail.toString("utf8")}`;
  }
}

/**
 * Strip the variables that make a nested agent think it is still inside its
 * parent. Auth material is left alone — the child must use the CLI login the
 * user already has.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|.*_PORT)|CODEX_SANDBOX.*|OPENCODE_(SESSION|SERVER).*|GEMINI_CLI_SESSION.*|MUSE_(SESSION_ID|CURRENT_SESSION_LOG)|TBH_SESSION_MESSAGE_SOCKET)$/.test(key)) {
      delete env[key];
    }
  }
  env.CI = "1";
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    // Negative pid: the whole detached group, so helper processes die too.
    // Still valid once the leader is reaped, as long as the group has members.
    process.kill(-pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

export async function invokeAgent(req: AgentRequest): Promise<AgentResult> {
  const adapter = adapterFor(req.provider.cli);
  if (!adapter) {
    throw new Error(`unsupported CLI "${req.provider.cli}" (supported: ${SUPPORTED_CLIS.join(", ")}); refusing to guess flags`);
  }
  const role = asRole(req.role);
  if (!adapter.roles.has(role)) throw new Error(adapter.unsupported(role));
  if (!req.prompt.trim()) throw new Error("prompt is empty");
  if (typeof req.timeoutMs !== "number" || !Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0) {
    throw new Error(`timeoutMs must be a finite positive number of milliseconds, got ${JSON.stringify(req.timeoutMs)}`);
  }

  // The five-minute ceiling is the whole run, kill grace included: TERM goes
  // out early enough that the SIGKILL lands on the deadline, not after it.
  const budgetMs = Math.min(req.timeoutMs, MAX_TIMEOUT_MS);
  const graceMs = Math.min(KILL_GRACE_MS, Math.max(200, Math.floor(budgetMs / 10)));
  const termAtMs = Math.max(1, budgetMs - graceMs);

  const command = splitCommand(req.provider.command);
  if (req.verifyFlags !== false) await assertAdapterFlags(req.provider, role, req.run);

  let argv = adapter.args(role);
  if (adapter.cli === 'codex' && !existsSync(join(req.cwd, '.git'))) argv = [...argv.slice(0, 1), '--skip-git-repo-check', ...argv.slice(1)];
  mkdirSync(dirname(resolve(req.logPath)), { recursive: true, mode: 0o700 });
  // A file, not an argument: prompts outgrow Linux's 128 KiB per-argument cap.
  const promptPath = `${req.logPath}.prompt`;
  if (adapter.promptFlag) writeFileSync(promptPath, req.prompt, { mode: 0o600 });
  const fullArgv = adapter.promptFlag ? [...argv, adapter.promptFlag, resolve(promptPath)] : argv;
  // Open with an explicit restrictive mode: transcripts can hold secrets.
  const fd = openSync(req.logPath, "a", 0o600);
  const log = createWriteStream("", { fd, autoClose: true });
  log.write(`# ${new Date().toISOString()} ${req.provider.id} role=${role} budget=${budgetMs}ms term=${termAtMs}ms\n`);

  const started = Date.now();
  const out = new BoundedOutput();
  const child = spawn(command[0]!, [...command.slice(1), ...fullArgv], {
    cwd: req.cwd,
    env: childEnv(process.env, req.env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true, // own process group, so the timeout kill reaches children
    shell: false,
  });

  const finished = new Promise<{ code: number | null; signal: string | null }>((res, rej) => {
    child.once("error", rej);
    child.once("close", (c, s) => res({ code: c, signal: s }));
  });

  let timedOut = false;
  let aborted = false;
  let softPassed = false;
  let signature: string | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;
  let softTimer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  const cleanup = () => {
    if (hardTimer) clearTimeout(hardTimer);
    if (softTimer) clearTimeout(softTimer);
    if (killTimer) clearTimeout(killTimer);
    if (onAbort) req.signal?.removeEventListener("abort", onAbort);
    if (child.pid) OWNED.delete(child.pid);
    log.end();
  };

  if (child.pid) OWNED.add(child.pid);
  try {
    // Recorded before any await, so a crash still leaves a pid behind. If the
    // caller's bookkeeping throws we have an unrecorded child: kill it and let
    // the error out, rather than leaking a process nobody can find later.
    req.onSpawn?.(child.pid ?? 0);
  } catch (e) {
    killGroup(child, "SIGKILL");
    child.stdin?.destroy();
    await finished.catch(() => undefined);
    killGroup(child, "SIGKILL");
    cleanup();
    throw e;
  }

  const signaturePending =
    req.onSignature && child.pid
      ? processSignature(child.pid)
          .then((s) => {
            if (!s) return;
            signature = s;
            req.onSignature?.(child.pid!, s);
          })
          .catch(() => undefined)
      : undefined;

  try {
    const capture = (stream: NodeJS.ReadableStream | null) => {
      stream?.on("data", (c: Buffer) => {
        out.push(c);
        log.write(c);
      });
    };
    capture(child.stdout);
    capture(child.stderr);

    if (adapter.promptFlag) {
      child.stdin?.end();
    } else {
      child.stdin?.on("error", () => {
        /* child may exit before reading the prompt */
      });
      child.stdin?.end(req.prompt);
    }

    const escalate = () => {
      killGroup(child, "SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), graceMs);
      killTimer.unref?.();
    };

    hardTimer = setTimeout(() => {
      timedOut = true;
      escalate();
    }, termAtMs);
    softTimer = setTimeout(() => {
      softPassed = true;
      req.onSoftCheckpoint?.();
    }, Math.min(SOFT_CHECKPOINT_MS, termAtMs));
    onAbort = () => {
      aborted = true;
      escalate();
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) onAbort();

    const { code, signal } = await finished;
    // The parent can die on the first SIGTERM while its grandchildren keep the
    // group alive. The run is over either way, so reap the group unconditionally
    // — a leashed run does not get to leave background processes behind.
    killGroup(child, "SIGKILL");
    if (signaturePending) await signaturePending;

    const text = out.text();
    log.write(`\n# exit=${code} signal=${signal} elapsed=${Date.now() - started}ms\n`);
    return {
      exitCode: code,
      signal,
      timedOut,
      aborted,
      elapsedMs: Date.now() - started,
      text,
      pid: child.pid,
      signature,
      softCheckpointPassed: softPassed,
      truncated: out.truncated,
      logPath: req.logPath,
    };
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Structured report parsing
// ---------------------------------------------------------------------------

export const REPORT_MARKER = "WAN_RESULT";

/** Scan a balanced JSON value starting at `start`, string- and escape-aware. */
function scanJson(text: string, start: number): string | undefined {
  const open = text[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : undefined;
  if (!close) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (!depth) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function firstJsonAfter(text: string, from: number): string | undefined {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      const found = scanJson(text, i);
      if (found) return found;
    }
  }
  return undefined;
}

function fencedBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[1] || /^(json|wan_result)$/i.test(m[1])) out.push(m[2]!);
  }
  return out;
}

/** Unwrap a provider envelope such as `{"type":"result","result":"<text>"}`. */
function unwrapEnvelope(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 3 || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ["result", "response", "text", "output", "content"]) {
    const inner = obj[key];
    if (typeof inner === "string") {
      try {
        return parseAgentReport(inner);
      } catch {
        /* envelope field held prose, not a report */
      }
    } else if (inner && typeof inner === "object") {
      const nested = unwrapEnvelope(inner, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

function asRecord(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * Pull the agent's structured report out of its transcript.
 *
 * Only an explicit `WAN_RESULT` marker, a fenced JSON block, or a whole-body
 * JSON document counts. Prose is never a report: an agent that writes "done"
 * and nothing else has not reported anything, and saying so loudly is the
 * whole point of this function.
 */
export function parseAgentReport(text: string): Record<string, unknown> {
  if (typeof text !== "string" || !text.trim()) throw new Error("agent report is empty");

  // A marker is the strongest signal, but it can also appear *inside* a
  // provider envelope's escaped string, or inside the report itself (a
  // supervisor diagnosing "no WAN_RESULT across 9 attempts"), where the bytes
  // after it are not a report. Try every occurrence, last first, and take the
  // first one that is followed by a JSON object. Remember why the last marker
  // failed and keep looking.
  let markerError: Error | undefined;
  for (
    let marker = text.lastIndexOf(REPORT_MARKER);
    marker >= 0;
    marker = marker > 0 ? text.lastIndexOf(REPORT_MARKER, marker - 1) : -1
  ) {
    const raw = firstJsonAfter(text, marker + REPORT_MARKER.length);
    const rec = raw ? asRecord(raw) : undefined;
    if (rec) return unwrapEnvelope(rec) ?? rec;
    markerError ??= new Error(
      raw
        ? `${REPORT_MARKER} payload is not a JSON object: ${raw.slice(0, 200)}`
        : `found ${REPORT_MARKER} marker but no JSON object after it`,
    );
  }

  const fences = fencedBlocks(text);
  for (const block of fences.reverse()) {
    const raw = firstJsonAfter(block, 0);
    const rec = raw ? asRecord(raw) : undefined;
    if (rec) return unwrapEnvelope(rec) ?? rec;
  }

  const whole = asRecord(text.trim());
  if (whole) return unwrapEnvelope(whole) ?? whole;

  if (markerError) throw markerError;
  throw new Error(
    `no structured report found: expected a ${REPORT_MARKER} {...} line, a fenced JSON block, or a JSON document (got ${text.trim().length} chars of prose)`,
  );
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** pids this module spawned and has not yet reaped. */
const OWNED = new Set<number>();

export function ownedPids(): number[] {
  return [...OWNED];
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The process group id of `pid`, read from `ps`.
 *
 * Node has no `process.getpgid`; declaring one would only paper over the fact
 * that the information has to come from the OS. `ps -o pgid= -p <pid>` is the
 * portable (macOS and Linux) way to ask.
 */
export async function processGroupId(pid: number, run: CommandRunner = runCommand): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const r = await run("ps", ["-o", "pgid=", "-p", String(pid)], { timeoutMs: 15_000 }).catch(() => undefined);
  if (!r || r.code !== 0) return undefined;
  const value = Number(r.stdout.trim().split(/\s+/)[0]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * A cheap identity for "this exact process", so a recorded pid that has since
 * been recycled by the OS cannot be mistaken for the one we started. Start
 * time plus command is enough: pid reuse gives you the number back, never the
 * same start time.
 */
export async function processSignature(pid: number, run: CommandRunner = runCommand): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const r = await run("ps", ["-o", "lstart=,comm=", "-p", String(pid)], { timeoutMs: 15_000 }).catch(() => undefined);
  if (!r || r.code !== 0) return undefined;
  const line = r.stdout.trim().replace(/\s+/g, " ");
  return line ? `${pid}:${line}` : undefined;
}

export interface TerminateOptions {
  graceMs?: number;
  /**
   * Birth signature recorded when the process was started. Required for any
   * pid this process did not spawn — that is the only way to know the number
   * still refers to the same process after a supervisor restart.
   */
  signature?: string;
  run?: CommandRunner;
}

/**
 * Kill a process group we own.
 *
 * "Own" means one of two things: spawned by `invokeAgent` inside *this*
 * process, or — for cross-process recovery after a supervisor restart — a
 * group leader outside our own group whose birth signature still matches the
 * one the caller recorded when it was started. Anything else (pid 0/1,
 * ourselves, our parent, a recycled pid, a bare member of someone else's
 * group) throws rather than guessing.
 */
export async function terminateOwnedProcess(pid: number, options: TerminateOptions = {}): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to signal pid ${pid}: invalid or init`);
  if (pid === process.pid || pid === process.ppid) throw new Error(`refusing to signal pid ${pid}: that is this process or its parent`);
  const run = options.run ?? runCommand;

  if (!OWNED.has(pid)) {
    if (!options.signature) {
      throw new Error(`refusing to signal pid ${pid}: this process did not spawn it and no birth signature was recorded`);
    }
    const current = await processSignature(pid, run);
    if (!current) return; // already gone
    if (current !== options.signature) {
      throw new Error(`refusing to signal pid ${pid}: birth signature changed (recorded ${options.signature}, now ${current}) — the pid was recycled`);
    }
    const pgid = await processGroupId(pid, run);
    if (pgid === undefined) return; // gone between the two reads
    if (pgid !== pid) throw new Error(`refusing to signal pid ${pid}: not a process-group leader (pgid ${pgid}), so not ours to kill`);
    const self = await processGroupId(process.pid, run);
    if (self !== undefined && pgid === self) throw new Error(`refusing to signal pid ${pid}: shares this process's group`);
  }

  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone */
      }
    }
  };

  send("SIGTERM");
  const deadline = Date.now() + (options.graceMs ?? KILL_GRACE_MS);
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      send("SIGKILL"); // sweep up any grandchildren still holding the group open
      OWNED.delete(pid);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  send("SIGKILL");
  OWNED.delete(pid);
}

// ---------------------------------------------------------------------------
// Git identity
// ---------------------------------------------------------------------------

/** The bot identity every automated commit must run under, exactly. */
export const BOT_GIT_NAME = "dougbot-agent";
export const BOT_GH_LOGIN = "dougbot-agent";
/** GitHub noreply address for that account, with or without the numeric id. */
export const BOT_EMAIL = /^(?:[0-9]+\+)?dougbot-agent@users\.noreply\.github\.com$/;

export interface BotIdentity {
  name: string;
  email: string;
  login: string;
}

/**
 * How to reach git and gh. Injected wholesale so tests can point at fixture
 * binaries; there is deliberately no environment variable that relaxes *who*
 * we must be, only how to invoke the tools.
 */
export interface GitTools {
  run: CommandRunner;
  /**
   * Argv that runs git under the bot identity. On macOS the host carries a
   * `git dougbot` alias that swaps GIT_CONFIG_GLOBAL to the bot's config, so
   * every read and every write goes through it. Elsewhere there is no alias
   * and the repository's own config has to already be the bot.
   */
  gitBot: readonly string[];
  gh: readonly string[];
}

export function defaultGitTools(platform: string = process.platform): GitTools {
  return {
    run: runCommand,
    gitBot: platform === "darwin" ? ["git", "dougbot"] : ["git"],
    gh: ["gh"],
  };
}

/** Every git invocation in this module goes through here — reads included. */
async function botGit(tools: GitTools, cwd: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  const dir = resolve(cwd);
  const [bin, ...prefix] = tools.gitBot;
  if (!bin) throw new Error("GitTools.gitBot is empty");
  // cwd is set as well as -C: a `!`-shell alias resolves relative to the
  // process directory before the inner git sees -C.
  return tools.run(bin, [...prefix, "-C", dir, ...args], { cwd: dir, timeoutMs });
}

async function git(tools: GitTools, cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const r = await botGit(tools, cwd, args, timeoutMs);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  if (r.truncated) throw new Error(`git ${args.join(" ")} produced more than ${MAX_CAPTURE_BYTES} bytes; refusing to use a partial result`);
  return r.stdout;
}

/**
 * Refuse to make a git write under a human's identity. Both halves are
 * checked: the local commit identity *and* the credential the host would push
 * with, so a commit can never end up attributed to the user. The expected
 * identity is a constant — there is no override, because an override is just
 * a way to turn the check off.
 *
 * Nothing here ever runs `git config --global user.name`: repairing a wrong
 * identity by writing one is how personal details end up in bot commits.
 */
export async function verifyBotIdentity(cwd: string, tools: GitTools = defaultGitTools()): Promise<BotIdentity> {
  const read = async (key: string) => (await botGit(tools, cwd, ["config", "--get", key], 15_000)).stdout.trim();
  const name = await read("user.name");
  const email = await read("user.email");

  if (name !== BOT_GIT_NAME) {
    throw new Error(`refusing git write in ${cwd}: user.name is "${name || "(unset)"}", expected exactly "${BOT_GIT_NAME}"`);
  }
  if (!BOT_EMAIL.test(email)) {
    throw new Error(`refusing git write in ${cwd}: user.email is "${email || "(unset)"}", expected ${BOT_GIT_NAME}'s GitHub noreply address`);
  }

  const [ghBin, ...ghPrefix] = tools.gh;
  if (!ghBin) throw new Error("GitTools.gh is empty");
  const gh = await tools.run(ghBin, [...ghPrefix, "api", "user", "--jq", ".login"], { timeoutMs: 20_000 }).catch((e: Error) => ({
    code: -1,
    stdout: "",
    stderr: e.message,
  }));
  const login = gh.stdout.trim();
  if (gh.code !== 0) throw new Error(`refusing git write: could not confirm gh identity (${gh.stderr.trim() || gh.code})`);
  if (login !== BOT_GH_LOGIN) throw new Error(`refusing git write: gh is authenticated as "${login}", expected "${BOT_GH_LOGIN}"`);

  return { name, email, login };
}

// ---------------------------------------------------------------------------
// Git / workspace
// ---------------------------------------------------------------------------

export async function gitRevision(cwd: string, tools: GitTools = defaultGitTools()): Promise<string> {
  return (await git(tools, cwd, ["rev-parse", "HEAD"])).trim();
}

/** Creating a worktree writes to the repository, so the identity is checked first. */
export async function createWorktree(repo: string, path: string, branch: string, base: string, tools: GitTools = defaultGitTools()): Promise<void> {
  if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`);
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..") || branch.endsWith(".lock")) {
    throw new Error(`unsafe branch name: ${branch}`);
  }
  await verifyBotIdentity(repo, tools);
  await git(tools, repo, ["worktree", "add", "-b", branch, resolve(path), base], 120_000);
}

/** Keep loop bookkeeping out of every commit we make. */
function excludeMetadata(cwd: string): void {
  const file = join(cwd, ".git", "info", "exclude");
  try {
    if (!existsSync(dirname(file))) return; // linked worktree: .git is a file
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!current.includes(".wan")) writeFileSync(file, `${current}${current.endsWith("\n") || !current ? "" : "\n"}.wan*\n`, { mode: 0o644 });
  } catch {
    /* best effort — the add below also filters */
  }
}

/**
 * Commit whatever the agent actually changed, under the bot identity. Never
 * pushes; the caller decides if anything leaves the machine.
 */
export async function snapshotWorkspace(cwd: string, message: string, tools: GitTools = defaultGitTools()): Promise<string> {
  await verifyBotIdentity(cwd, tools);
  excludeMetadata(cwd);
  await git(tools, cwd, ["add", "-A", "--", ":!.wan*", ":!**/.wan*"]);
  const staged = await botGit(tools, cwd, ["diff", "--cached", "--name-only"], 30_000);
  if (!staged.stdout.trim()) return gitRevision(cwd, tools); // nothing changed; not an error
  await git(tools, cwd, ["commit", "--no-gpg-sign", "-m", message]);
  return gitRevision(cwd, tools);
}

/** A patch bigger than this is a reviewing problem, not an applying problem. */
export const MAX_PATCH_BYTES = 4 * 1024 * 1024;
/** Default cap on the *display* diff. Never used for applying. */
export const DISPLAY_DIFF_BYTES = 256 * 1024;

export interface WorkspaceChanges {
  files: string[];
  /** Possibly-elided text for humans and prompts. Never apply this. */
  diff: string;
  /** Size of the real patch, before any elision. */
  patchBytes: number;
  truncated: boolean;
}

function isMetadata(file: string): boolean {
  return file.split("/").some((seg) => seg === ".git" || seg.startsWith(".wan"));
}

async function buildPatch(cwd: string, base: string, tools: GitTools): Promise<{ files: string[]; patch: string }> {
  const tracked = (await git(tools, cwd, ["diff", "--name-only", base])).split("\n").filter(Boolean);
  const untracked = (await git(tools, cwd, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])].filter((f) => !isMetadata(f)).sort();

  let patch = await git(tools, cwd, ["diff", "--binary", base], 120_000);
  for (const f of untracked) {
    if (isMetadata(f)) continue;
    // --no-index exits 1 when files differ, which is the normal case here.
    const r = await botGit(tools, cwd, ["diff", "--binary", "--no-index", "--", "/dev/null", f], 30_000);
    if (r.truncated) throw new Error(`the diff for untracked ${f} exceeded ${MAX_CAPTURE_BYTES} bytes; refusing to build a partial patch`);
    patch += r.stdout;
  }
  return { files, patch };
}

/** Committed + uncommitted work against `base`, summarised for review. */
export async function inspectChanges(
  cwd: string,
  base: string,
  options: { displayBytes?: number; tools?: GitTools } = {},
): Promise<WorkspaceChanges> {
  const tools = options.tools ?? defaultGitTools();
  const cap = options.displayBytes ?? DISPLAY_DIFF_BYTES;
  const { files, patch } = await buildPatch(cwd, base, tools);
  const truncated = patch.length > cap;
  return {
    files,
    diff: truncated ? `${patch.slice(0, cap)}\n…[diff truncated at ${cap} bytes for display; ${patch.length} bytes total]…\n` : patch,
    patchBytes: patch.length,
    truncated,
  };
}

/**
 * The *full* patch, for applying. A truncated diff is not a patch, so an
 * oversized one is refused outright instead of quietly corrupting the target.
 */
export async function changePatch(cwd: string, base: string, tools: GitTools = defaultGitTools()): Promise<{ files: string[]; patch: string }> {
  const built = await buildPatch(cwd, base, tools);
  if (built.patch.length > MAX_PATCH_BYTES) {
    throw new Error(
      `refusing to integrate: patch is ${built.patch.length} bytes, over the ${MAX_PATCH_BYTES}-byte limit ` +
        `(${built.files.length} files) — split the task rather than applying a partial patch`,
    );
  }
  return built;
}

// ---------------------------------------------------------------------------
// Ownership matching
// ---------------------------------------------------------------------------

/**
 * Normalise a repo-relative path, or reject it outright.
 *
 * Rejected anywhere in the path, not just at the front: `..` traversal,
 * absolute and drive-letter paths, the `.git` directory, and the loop's own
 * `.wan*` controller metadata. None of those are ever an agent's to touch.
 */
function normalizeRelative(file: string): string | undefined {
  if (typeof file !== "string") return undefined;
  const raw = file.replace(/\\/g, "/").trim();
  if (!raw || raw.startsWith("/") || isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.includes("\0")) return undefined;
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length) return undefined;
  for (const seg of parts) {
    if (seg === ".." || seg === ".git" || seg.startsWith(".wan")) return undefined;
  }
  return parts.join("/");
}

function segmentMatch(pattern: string, segment: string): boolean {
  const re = `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`;
  return new RegExp(re).test(segment);
}

/** `**` spans zero or more whole segments; `*` and `?` never cross a `/`. */
function globMatch(pattern: string[], path: string[], pi = 0, si = 0): boolean {
  if (pi === pattern.length) return si === path.length;
  const seg = pattern[pi]!;
  if (seg === "**") {
    for (let k = si; k <= path.length; k++) if (globMatch(pattern, path, pi + 1, k)) return true;
    return false;
  }
  if (si >= path.length) return false;
  if (!segmentMatch(seg, path[si]!)) return false;
  return globMatch(pattern, path, pi + 1, si + 1);
}

function matchOwnership(path: string, pattern: string): boolean {
  let p = pattern.replace(/\\/g, "/").trim().replace(/^\.\//, "");
  if (!p || p.startsWith("/") || isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false;
  const isDir = p.endsWith("/");
  if (isDir) p = p.replace(/\/+$/, "");
  const segs = p.split("/").filter((s) => s !== "" && s !== ".");
  if (!segs.length || segs.includes("..")) return false;
  if (isDir) segs.push("**");
  // A plain path with no wildcards owns the file itself and everything under it.
  if (!segs.some((s) => s.includes("*") || s.includes("?"))) {
    const joined = segs.join("/");
    return path === joined || path.startsWith(`${joined}/`);
  }
  return globMatch(segs, path.split("/"));
}

/**
 * Is `file` inside the agent's declared ownership?
 *
 * Patterns: `src/loop/runtime.ts` (that file), `src/loop` or `src/loop/` (that
 * directory and everything under it), `src/**` (same), `src/*.ts` (one level),
 * `src/loop*` (siblings at that level only — `*` does not cross a `/`; use a
 * trailing `/` or `/**` to own a subtree).
 */
export function pathAllowed(file: string, ownership: string[]): boolean {
  const norm = normalizeRelative(file);
  if (!norm) return false;
  return ownership.some((own) => matchOwnership(norm, own));
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

export interface IntegrationResult {
  /** The target's revision afterwards — unchanged when nothing was integrated. */
  revision: string;
  integrated: boolean;
  files: string[];
  reason: string;
}

/**
 * Move a worker's committed + uncommitted work into the target tree.
 *
 * Deliberately conservative: it refuses anything outside the agent's declared
 * ownership, refuses files the *target* has itself changed since the shared
 * base, and applies with `--3way` only after `--check` passes on the full
 * patch. Changes the target picked up from *earlier, disjoint* tasks are fine
 * — the target having moved on is the normal case, and only a genuine overlap
 * on the same file is a conflict.
 *
 * The worker worktree is never reset, cleaned or deleted, on success or on
 * failure. Whatever happens, the work is still on disk where it was made.
 */
export async function integrateWorktree(
  target: string,
  worker: string,
  base: string,
  ownership: string[],
  tools: GitTools = defaultGitTools(),
): Promise<IntegrationResult> {
  if (!ownership.length) throw new Error("refusing to integrate with an empty ownership list");

  const { files, patch } = await changePatch(worker, base, tools);
  if (!files.length || !patch.trim()) {
    // Not a failure: an agent can legitimately conclude there is nothing to do,
    // and retrying it forever is how a loop wedges. The caller decides what the
    // empty result means, normally by having a coordinator inspect it.
    return {
      revision: await gitRevision(target, tools),
      integrated: false,
      files: [],
      reason: `no changes in ${worker} against ${base}`,
    };
  }

  const outside = files.filter((f) => !pathAllowed(f, ownership));
  if (outside.length) throw new Error(`refusing to integrate: out-of-scope paths ${outside.join(", ")} (owned: ${ownership.join(", ")})`);

  const targetChanged = (await git(tools, target, ["diff", "--name-only", base])).split("\n").filter(Boolean).filter((f) => !isMetadata(f));
  const overlap = files.filter((f) => targetChanged.includes(f));
  if (overlap.length) throw new Error(`refusing to integrate: ${target} already changed ${overlap.join(", ")} since ${base}`);

  // Checked before anything touches the index, not just before the commit.
  await verifyBotIdentity(target, tools);

  const check = await applyPatch(tools, target, ["apply", "--check", "--3way", "-"], patch);
  if (check.code !== 0) throw new Error(`patch does not apply cleanly to ${target}: ${check.stderr.trim()}`);

  const apply = await applyPatch(tools, target, ["apply", "--3way", "--index", "-"], patch);
  if (apply.code !== 0) throw new Error(`git apply failed on ${target} (source preserved at ${worker}): ${apply.stderr.trim()}`);

  await git(tools, target, ["commit", "--no-gpg-sign", "-m", `integrate ${basename(worker)}\n\n${files.join("\n")}`]);
  return {
    revision: await gitRevision(target, tools),
    integrated: true,
    files,
    reason: `integrated ${files.length} file(s) from ${worker}`,
  };
}

async function applyPatch(tools: GitTools, cwd: string, args: string[], patch: string): Promise<RunResult> {
  const dir = resolve(cwd);
  const [bin, ...prefix] = tools.gitBot;
  if (!bin) throw new Error("GitTools.gitBot is empty");
  return tools.run(bin, [...prefix, "-C", dir, ...args], { cwd: dir, timeoutMs: 120_000, input: patch });
}

// ---------------------------------------------------------------------------
// Artifact hashing
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

/**
 * A content hash of what the agent actually produced. Symlinks are recorded by
 * their target string and never followed, so a link into /etc can't smuggle
 * host content into the inventory (or send the walk into a cycle).
 */
export async function artifactRevision(cwd: string): Promise<string> {
  const root = resolve(cwd);
  const lines: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".wan")) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        // Record the link target, never the content behind it.
        lines.push(`symlink ${rel} ${hashString(safeReadlink(full))}`);
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = lstatSync(full);
      lines.push(`file ${rel} ${st.size} ${hashFile(full)}`);
    }
  };
  walk(root);

  return `sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}

function safeReadlink(p: string): string {
  try {
    return readlinkSync(p);
  } catch {
    return "";
  }
}

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function hashFile(p: string): string {
  const h = createHash("sha256");
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(1 << 16);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) {
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Host process helpers
// ---------------------------------------------------------------------------

const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;

export interface TmuxOptions {
  name: string;
  cwd: string;
  command: string[];
  logPath: string;
}

export async function tmuxAlive(name: string): Promise<boolean> {
  if (!SAFE_NAME.test(name)) return false;
  const r = await runCommand("tmux", ["has-session", "-t", `=${name}`], { timeoutMs: 15_000 });
  return r.code === 0;
}

/**
 * Start a detached, named tmux session.
 *
 * The session is created blocked on a ready file so `pipe-pane` is wired up
 * *before* the real command emits anything — otherwise the first seconds of
 * output, which is where startup failures live, are lost.
 */
export async function tmuxStart({ name, cwd, command, logPath }: TmuxOptions): Promise<void> {
  if (!SAFE_NAME.test(name)) throw new Error(`unsafe tmux session name: ${name}`);
  if (!command.length) throw new Error("tmux command is empty");
  if (await tmuxAlive(name)) throw new Error(`tmux session "${name}" already exists; refusing to clobber it`);

  mkdirSync(dirname(resolve(logPath)), { recursive: true, mode: 0o700 });
  closeSync(openSync(logPath, "a", 0o600));
  const ready = `${resolve(logPath)}.ready`;

  // tmux hands this string to sh, so every piece is single-quoted.
  const inner = `while [ ! -f ${shellQuote(ready)} ]; do sleep 0.05; done; rm -f ${shellQuote(ready)}; exec ${command.map(shellQuote).join(" ")}`;

  await tmuxRun(["new-session", "-d", "-s", name, "-c", resolve(cwd), "sh", "-c", inner]);
  await tmuxRun(["set-option", "-w", "-t", `${name}:0`, "remain-on-exit", "on"]);
  await tmuxRun(["set-option", "-w", "-t", `${name}:0`, "history-limit", "100000"]);
  await tmuxRun(["pipe-pane", "-o", "-t", `${name}:0.0`, `cat >> ${shellQuote(resolve(logPath))}`]);
  writeFileSync(ready, "", { mode: 0o600 });
}

async function tmuxRun(args: string[]): Promise<void> {
  const r = await runCommand("tmux", args, { timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`tmux ${args[0]} failed (${r.code}): ${r.stderr.trim()}`);
}

// ---------------------------------------------------------------------------
// Service definitions
// ---------------------------------------------------------------------------

export interface ServiceSpec {
  name: string;
  command: string[];
  cwd: string;
  logPath: string;
  /**
   * Extra environment for the service. PATH defaults to the current one:
   * neither launchd nor systemd inherits a login shell's PATH, so without it
   * the CLIs are simply not found after a reboot.
   */
  env?: Record<string, string>;
}

export interface ServiceDefinition {
  path: string;
  content: string;
  install: string[];
  uninstall: string[];
  /** Operational caveats the caller should surface rather than discover. */
  notes: string[];
}

function assertServiceValue(label: string, value: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error(`${label} must be a single line without NUL: ${JSON.stringify(value)}`);
  return value;
}

function xmlEscape(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) throw new Error(`control character in launchd value: ${JSON.stringify(s)}`);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * A systemd unit value. `%` starts a specifier, so a literal one must be
 * doubled — `shellQuote` knows nothing about that and would leave a live
 * `%h`/`%i` in the file.
 */
function sdPlain(label: string, value: string): string {
  assertServiceValue(label, value);
  if (value.includes('"')) throw new Error(`${label} must not contain a double quote: ${JSON.stringify(value)}`);
  return value.replace(/%/g, "%%");
}

/** One ExecStart/Environment word, in systemd's own quoting (not POSIX sh). */
function sdWord(label: string, value: string): string {
  assertServiceValue(label, value);
  const bare = /^[A-Za-z0-9_@:,./=+-]+$/.test(value) && value.length > 0;
  const quoted = bare ? value : `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return quoted.replace(/%/g, "%%");
}

/**
 * Render (never install) a supervisor definition for the persistent host
 * process. The caller installs it deliberately with the returned commands.
 *
 * Restart policy is failure-only on both platforms. A supervisor that has
 * reached a terminal state exits 0 and must then stay down — launchd's
 * unconditional `KeepAlive` would relaunch it in a tight loop forever, which
 * on a dev machine looks exactly like the host being wedged.
 */
export function serviceDefinition(spec: ServiceSpec, platform: string = process.platform): ServiceDefinition {
  if (!SAFE_NAME.test(spec.name)) throw new Error(`unsafe service name: ${spec.name}`);
  if (!spec.command.length) throw new Error("service command is empty");
  const cwd = resolve(spec.cwd);
  const log = resolve(spec.logPath);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...(spec.env ?? {}) };

  if (platform === "darwin") {
    const label = `com.wan.${spec.name}`;
    const path = join(process.env.HOME ?? "~", "Library", "LaunchAgents", `${label}.plist`);
    const args = spec.command.map((a) => `    <string>${xmlEscape(assertServiceValue("launchd argument", a))}</string>`).join("\n");
    const envEntries = Object.entries(env)
      .map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(assertServiceValue(`launchd env ${k}`, v))}</string>`)
      .join("\n");
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(cwd)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart on crash only. A clean exit is the supervisor saying it is done. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
    return {
      path,
      content,
      install: [`launchctl bootstrap gui/$(id -u) ${shellQuote(path)}`, `launchctl enable gui/$(id -u)/${label}`],
      uninstall: [`launchctl bootout gui/$(id -u)/${label}`],
      notes: [
        "KeepAlive is SuccessfulExit=false: the supervisor must exit 0 when it reaches a terminal state, or launchd will restart it forever.",
        "This is a per-user LaunchAgent in the gui/$(id -u) domain: it starts at GUI login and stops at logout, not at boot. Use a LaunchDaemon if it must survive logout.",
        "PATH is pinned in EnvironmentVariables because launchd does not read a login shell; agent CLIs would otherwise be missing after a reboot.",
      ],
    };
  }

  if (platform === "linux") {
    const unit = `wan-${spec.name}.service`;
    const path = join(process.env.HOME ?? "~", ".config", "systemd", "user", unit);
    const exec = spec.command.map((a) => sdWord("ExecStart argument", a)).join(" ");
    const envLines = Object.entries(env)
      .map(([k, v]) => `Environment=${sdWord(`Environment ${k}`, `${k}=${v}`)}`)
      .join("\n");
    const content = `[Unit]
Description=${sdPlain("Description", `wan loop ${spec.name}`)}
After=network.target

[Service]
Type=simple
WorkingDirectory=${sdWord("WorkingDirectory", cwd)}
ExecStart=${exec}
${envLines}
StandardOutput=append:${sdPlain("StandardOutput", log)}
StandardError=append:${sdPlain("StandardError", log)}
# Restart on failure only: exit 0 means the supervisor finished deliberately.
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    return {
      path,
      content,
      install: ["systemctl --user daemon-reload", `systemctl --user enable --now ${unit}`],
      uninstall: [`systemctl --user disable --now ${unit}`, "systemctl --user daemon-reload"],
      notes: [
        "Restart=on-failure: the supervisor must exit 0 when it reaches a terminal state, or systemd will restart it forever.",
        "This is a --user unit: it runs only while the user has a session. Run `loginctl enable-linger $USER` for it to start at boot and survive logout.",
        "PATH is pinned with Environment= because a systemd user unit does not inherit a login shell's PATH.",
      ],
    };
  }

  throw new Error(`no service definition for platform "${platform}" (supported: darwin, linux)`);
}
