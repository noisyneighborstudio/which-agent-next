import { homedir } from "node:os";
import { join } from "node:path";
import { PROBES } from "./probes.js";
import { agentId, pick, rank, reason, type Ranked } from "./rank.js";
import { DEFAULT_CONFIG, type Candidate, type Config, type Probe, type ProbeContext } from "./types.js";
import { readJson, withTimeout } from "./util.js";

export * from "./types.js";
export { PROBES } from "./probes.js";
export { rank, pick, reason, tierOf, tightest, agentId } from "./rank.js";

export { VERSION } from "./update.js";

/** Probes for the given CLI keys; every probe when none are given. */
export function probesFor(only: string[]): Probe[] {
  return only.length ? PROBES.filter((p) => only.includes(p.cli)) : PROBES;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "which-agent-next", "config.json");
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...(readJson<Partial<Config>>(configPath()) ?? {}), ...overrides };
}

/** Run every probe in parallel; a slow or broken one can't stall the rest. */
export async function collect(config: Config, probes: Probe[] = PROBES): Promise<Candidate[]> {
  const ctx: ProbeContext = { cacheMs: config.cacheMs, staleMs: config.staleMs };
  const results = await Promise.all(
    probes.map((p) =>
      withTimeout(
        p.run(ctx).catch((e): Candidate[] => [{
          id: p.cli, cli: p.cli, label: p.label, command: p.cli,
          state: "error", windows: [], note: (e as Error).message,
        }]),
        config.timeoutMs,
        [{
          id: p.cli, cli: p.cli, label: p.label, command: p.cli,
          state: "error", windows: [], note: `timed out after ${config.timeoutMs}ms`,
        }] as Candidate[],
      ),
    ),
  );
  return results.flat();
}

export interface Decision {
  winner?: Ranked;
  ranked: Ranked[];
  reason?: string;
}

export async function decide(config: Config, probes: Probe[] = PROBES): Promise<Decision> {
  const ranked = rank(await collect(config, probes), probes, config);
  const winner = pick(ranked);
  return { winner, ranked, reason: winner ? reason(winner, ranked) : undefined };
}

/** The `--json` shape: every candidate tagged with its stable agentId. */
export function report({ winner, ranked, reason }: Decision) {
  return {
    winner: winner ? { ...winner, agentId: agentId(winner) } : null,
    reason: reason ?? null,
    candidates: ranked.map((c) => ({ ...c, agentId: agentId(c) })),
  };
}
