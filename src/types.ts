/** A single rate-limit window reported by a provider. */
export interface UsageWindow {
  /** Short human label: "5h", "7d", "weekly". */
  label: string;
  /** 0-100. How much of the window is already spent. */
  usedPercent: number;
  /** ISO timestamp when the window rolls over, when known. */
  resetsAt?: string;
}

/**
 * Why a candidate can't be used, or how confident we are in its numbers.
 *
 * - `ready`         quota read successfully, headroom is real
 * - `unmetered`     no quota to run out of (local models)
 * - `unknown`       authenticated, but the CLI exposes no quota we can read
 * - `unauthenticated` installed but not logged in
 * - `error`         probe blew up or timed out
 */
export type CandidateState =
  | "ready"
  | "unmetered"
  | "unknown"
  | "unauthenticated"
  | "error";

/** One runnable agent: a CLI, or one profile of a multi-account CLI. */
export interface Candidate {
  /** Stable id: "claude:Expo", "codex". */
  id: string;
  /** CLI key this belongs to: "claude". */
  cli: string;
  /** Display name: "Claude Code (Expo)". */
  label: string;
  /** Account/profile name, when the CLI manages more than one identity. */
  profile?: string;
  /** The shell command to actually invoke this agent. */
  command: string;
  state: CandidateState;
  /** Every window the provider reports; the tightest one drives headroom. */
  windows: UsageWindow[];
  /** 0-100, `100 - max(usedPercent)`. Undefined when state isn't `ready`. */
  headroom?: number;
  /** When the quota numbers were observed. Absent means "live, just now". */
  observedAt?: number;
  /** Freeform detail: plan type, staleness, why it's unavailable. */
  note?: string;
}

export interface ProbeContext {
  /** Reuse a cached quota read younger than this. 0 forces a live fetch. */
  cacheMs: number;
  /** When a live fetch fails, a cached read younger than this still counts. */
  staleMs: number;
}

/** A probe discovers zero or more candidates for one CLI. */
export interface Probe {
  cli: string;
  label: string;
  /** Lower is more preferred when headroom is comparable. */
  preference: number;
  run(ctx: ProbeContext): Promise<Candidate[]>;
}

export interface Config {
  /** CLI keys in preference order; unlisted CLIs keep their built-in order. */
  prefer: string[];
  /** CLI keys or candidate ids to ignore entirely. */
  exclude: string[];
  /** Headroom below this counts as exhausted and is never picked. */
  minHeadroom: number;
  /** Per-probe timeout in milliseconds. */
  timeoutMs: number;
  /** Quota reads younger than this are served from cache. */
  cacheMs: number;
  /** On a failed live read, fall back to cache this old before giving up. */
  staleMs: number;
}

export const DEFAULT_CONFIG: Config = {
  prefer: [],
  exclude: [],
  minHeadroom: 5,
  timeoutMs: 8000,
  cacheMs: 60_000,
  staleMs: 30 * 60_000,
};
