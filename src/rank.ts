import type { Candidate, Config, Probe } from "./types.js";

/**
 * Tiers, best first. Quota is bucketed rather than compared raw so a slightly
 * emptier tank never demotes a much stronger agent: within a tier the
 * preference order decides, and only across tiers does usage win.
 */
export const TIERS = ["plenty", "ok", "unknown", "low", "local", "exhausted"] as const;
export type Tier = (typeof TIERS)[number];

const PLENTY = 50;
const OK = 20;

export function tierOf(c: Candidate, minHeadroom: number): Tier | undefined {
  switch (c.state) {
    case "ready": {
      const h = c.headroom ?? 0;
      if (h < minHeadroom) return "exhausted";
      if (h >= PLENTY) return "plenty";
      if (h >= OK) return "ok";
      return "low";
    }
    // Authenticated but the CLI publishes no quota. Ranked below anything
    // measured and healthy, above anything measured and nearly spent — we
    // refuse to invent a number for it.
    case "unknown":
      return "unknown";
    case "unmetered":
      return "local";
    default:
      return undefined; // unauthenticated / error: not runnable at all
  }
}

export interface Ranked extends Candidate {
  tier: Tier;
  /** Position in the effective preference order; lower is stronger. */
  preference: number;
  /** True when this one is actually pickable. */
  eligible: boolean;
}

/** Effective preference: explicit config order first, built-in order after. */
export function preferenceOf(cli: string, probes: Probe[], prefer: string[]): number {
  const i = prefer.indexOf(cli);
  if (i >= 0) return i;
  const builtin = probes.find((p) => p.cli === cli)?.preference ?? 99;
  return prefer.length + builtin;
}

export function rank(
  candidates: Candidate[],
  probes: Probe[],
  config: Config,
): Ranked[] {
  const excluded = new Set(config.exclude);
  return candidates
    .map((c): Ranked => {
      const tier = tierOf(c, config.minHeadroom);
      const dropped = excluded.has(c.cli) || excluded.has(c.id);
      return {
        ...c,
        tier: tier ?? "exhausted",
        preference: preferenceOf(c.cli, probes, config.prefer),
        eligible: Boolean(tier) && tier !== "exhausted" && !dropped,
        note: dropped ? [c.note, "excluded by config"].filter(Boolean).join("; ") : c.note,
      };
    })
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      const t = TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier);
      if (t) return t;
      if (a.preference !== b.preference) return a.preference - b.preference;
      const h = (b.headroom ?? -1) - (a.headroom ?? -1);
      if (h) return h;
      return a.id.localeCompare(b.id);
    });
}

export function pick(ranked: Ranked[]): Ranked | undefined {
  return ranked.find((c) => c.eligible);
}

/** One line explaining why the winner won, in terms of the runner-up. */
export function reason(winner: Ranked, ranked: Ranked[]): string {
  const quota = describeQuota(winner);
  const next = ranked.find((c) => c.eligible && c.id !== winner.id);
  if (!next) return `${quota}; nothing else is available`;
  if (next.tier !== winner.tier) return `${quota}; ${next.label} is ${next.tier}`;
  return `${quota}; preferred over ${next.label} at equal standing`;
}

function describeQuota(c: Ranked): string {
  if (c.state === "unmetered") return "local model, no quota";
  if (c.state === "unknown") return "no quota reported, assumed usable";
  const tight = tightest(c);
  return tight
    ? `${c.headroom}% headroom (${tight.label} window ${tight.usedPercent}% used)`
    : `${c.headroom}% headroom`;
}

/**
 * Stable identifier for an agent: `codex`, or `claude|Default` when the CLI
 * manages several accounts. Format depends only on whether the CLI has a
 * profile concept — never on how many happen to be configured — so a script
 * matching on it doesn't change behaviour when a profile is added or removed.
 */
export function agentId(c: Candidate): string {
  return c.profile ? `${c.cli}|${c.profile}` : c.cli;
}

/** The window closest to being spent — the one that will actually cut you off. */
export function tightest(c: Candidate) {
  return c.windows.length
    ? c.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
    : undefined;
}
