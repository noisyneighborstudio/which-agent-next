#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { collect, configPath, decide, loadConfig } from "./index.js";
import { shellQuote } from "./util.js";
import { PROBES } from "./probes.js";
import { agentId, rank } from "./rank.js";
import { renderExplain, renderTable } from "./render.js";
import type { Config } from "./types.js";

const VERSION = (() => {
  try {
    return createRequire(import.meta.url)("../package.json").version as string;
  } catch {
    return "0.0.0";
  }
})();

const HELP = `which-agent-next — pick the agent CLI with the most usage left.

  which-agent-next                 print the command for the best agent
  which-agent-next --explain       show the pick and every candidate
  which-agent-next --table         just the candidate table
  which-agent-next --json          machine-readable output
  which-agent-next --id            print <cli>|<profile> instead of a command
  which-agent-next --run -- <args> run the winning agent, passing <args> through

Everything after "--" is handed to the agent untouched, including flags that
collide with this tool's own ("-- --json -p hi" is the agent's --json).

Options:
  -e, --explain          pick plus full table, with the reason
  -t, --table            table only
  -i, --id               emit "<cli>|<profile>" (e.g. claude|Default, codex)
  -a, --all              emit every usable agent, best first, not just the pick
      --json             JSON: { winner, reason, candidates }
  -r, --run              exec the winning command
      --refresh          ignore cached quota reads and re-fetch
      --only <clis>      consider only these CLIs (comma-separated)
  -x, --exclude <ids>    skip these CLIs or candidate ids (comma-separated)
      --prefer <clis>    preference order for ties (comma-separated)
      --min-headroom <n> treat below n% remaining as exhausted (default 5)
      --timeout <ms>     per-probe timeout (default 8000)
      --cache <ms>       reuse quota reads younger than this (default 60000)
      --config           print the config file path
  -V, --version
  -h, --help

Exit codes: 0 picked, 3 nothing available, 2 bad usage.

Tiers, best first: plenty (>=50% left) · ok (>=20%) · unknown (no quota API)
· low (>=min-headroom) · local (unmetered) · exhausted. Within one tier the
preference order wins, so a stronger agent isn't demoted over a few percent.`;

interface Args {
  mode: "command" | "id" | "explain" | "table" | "json";
  all: boolean;
  run: boolean;
  only: string[];
  passthrough: string[];
  overrides: Partial<Config>;
}

function parse(argv: string[]): Args {
  const a: Args = { mode: "command", all: false, run: false, only: [], passthrough: [], overrides: {} };
  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  const need = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined) fail(`${flag} needs a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      a.passthrough = argv.slice(i + 1);
      break;
    }
    switch (arg) {
      case "-e": case "--explain": a.mode = "explain"; break;
      case "-t": case "--table": a.mode = "table"; break;
      case "-i": case "--id": a.mode = "id"; break;
      case "-a": case "--all": a.all = true; break;
      case "--json": a.mode = "json"; break;
      case "-r": case "--run": a.run = true; break;
      case "--refresh": a.overrides.cacheMs = 0; break;
      case "--only": a.only = list(need(i++, arg)); break;
      case "-x": case "--exclude": a.overrides.exclude = list(need(i++, arg)); break;
      case "--prefer": a.overrides.prefer = list(need(i++, arg)); break;
      case "--min-headroom": a.overrides.minHeadroom = Number(need(i++, arg)); break;
      case "--timeout": a.overrides.timeoutMs = Number(need(i++, arg)); break;
      case "--cache": a.overrides.cacheMs = Number(need(i++, arg)); break;
      case "--config": console.log(configPath()); process.exit(0); break;
      case "-V": case "--version": console.log(VERSION); process.exit(0); break;
      case "-h": case "--help": console.log(HELP); process.exit(0); break;
      default:
        fail(
          arg.startsWith("-")
            ? `unknown option: ${arg} — to pass it to the agent, put it after \`--\``
            : `unexpected argument: ${arg} — agent arguments go after \`--\``,
        );
    }
  }
  return a;
}

function fail(msg: string): never {
  console.error(`which-agent-next: ${msg}\n\n${HELP}`);
  process.exit(2);
}

async function main() {
  const args = parse(process.argv.slice(2));
  const config = loadConfig(args.overrides);
  const probes = args.only.length
    ? PROBES.filter((p) => args.only.includes(p.cli))
    : PROBES;
  if (!probes.length) fail(`--only matched no known CLI (have: ${PROBES.map((p) => p.cli).join(", ")})`);

  const { winner, ranked, reason } =
    args.mode === "table"
      ? { ...(await tableOnly(config, probes)), reason: undefined }
      : await decide(config, probes);

  switch (args.mode) {
    case "json":
      console.log(JSON.stringify({
        winner: winner ? { ...winner, agentId: agentId(winner) } : null,
        reason: reason ?? null,
        candidates: ranked.map((c) => ({ ...c, agentId: agentId(c) })),
      }, null, 2));
      break;
    case "table":
      console.log(renderTable(ranked));
      break;
    case "explain":
      console.log(renderExplain(winner, ranked, reason));
      break;
    case "id":
    case "command": {
      // With --run the command goes to the child, not to stdout.
      if (!winner || args.run) break;
      const chosen = args.all ? ranked.filter((c) => c.eligible) : [winner];
      const suffix = args.passthrough.map(shellQuote).join(" ");
      for (const c of chosen) {
        const base = args.mode === "id" ? agentId(c) : c.command;
        console.log(suffix && args.mode === "command" ? `${base} ${suffix}` : base);
      }
      break;
    }
  }

  if (!winner) {
    if (args.mode === "command")
      console.error("which-agent-next: no agent has usable capacity (try --explain)");
    process.exit(3);
  }

  if (args.run) {
    const [bin, ...rest] = winner.command.split(" ");
    if (args.mode === "command") console.error(`which-agent-next: running ${winner.command}`);
    const child = spawn(bin, [...rest, ...args.passthrough], { stdio: "inherit" });
    child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
    return;
  }
}

async function tableOnly(config: Config, probes = PROBES) {
  const ranked = rank(await collect(config, probes), probes, config);
  return { winner: ranked.find((c) => c.eligible), ranked };
}

main().catch((e) => {
  console.error(`which-agent-next: ${(e as Error).message}`);
  process.exit(1);
});
