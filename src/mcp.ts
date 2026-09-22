#!/usr/bin/env node
/**
 * which-agent-next-mcp — the same decision over MCP (stdio), for harnesses that
 * would rather call a tool than shell out. Dependency-free: newline-delimited
 * JSON-RPC 2.0, tools capability only.
 */
import { createInterface } from "node:readline";
import { decide, loadConfig, probesFor, report, VERSION, type Decision } from "./index.js";
import { PROBES } from "./probes.js";
import { agentId, tightest } from "./rank.js";
import type { Config } from "./types.js";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const clis = PROBES.map((p) => p.cli);

const FILTERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    only: {
      type: "array", items: { type: "string", enum: clis },
      description: "Consider only these CLIs.",
    },
    exclude: {
      type: "array", items: { type: "string" },
      description: "Skip these CLIs or candidate ids (e.g. \"codex\", \"claude:Scratch\").",
    },
    prefer: {
      type: "array", items: { type: "string", enum: clis },
      description: "Tie-break order within a tier. Unlisted CLIs keep the built-in order.",
    },
    minHeadroom: {
      type: "number", minimum: 0, maximum: 100,
      description: "Treat below this % remaining as exhausted (default 5).",
    },
    refresh: {
      type: "boolean",
      description: "Ignore the 60s quota cache. The Claude usage endpoint rate-limits; use sparingly.",
    },
  },
};

const TOOLS = [
  {
    name: "pick_agent",
    title: "Pick the agent CLI with the most quota left",
    description:
      "Choose which installed agent CLI (and which logged-in profile) should get the next job, " +
      "ranked by real remaining usage quota. Returns the winner's shell command and stable " +
      "agentId (`claude|Default`, `codex`), the reason, and the fallback chain. `winner` is null " +
      "when nothing has capacity. Tier `unknown` means the CLI exposes no quota — unmeasured, " +
      "not plentiful.",
    inputSchema: FILTERS,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_agents",
    title: "List every agent CLI and its quota",
    description:
      "Every detected agent CLI and profile, best first, including unusable ones with the " +
      "reason (not logged in, token expired, usage endpoint throttled). Each has tier, " +
      "headroom %, every rate-limit window with reset time, command, and agentId. Use to " +
      "report quota to a user; use pick_agent to just dispatch.",
    inputSchema: FILTERS,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

interface Filters {
  only?: string[];
  exclude?: string[];
  prefer?: string[];
  minHeadroom?: number;
  refresh?: boolean;
}

class ToolError extends Error {}

function strings(v: unknown, name: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string"))
    throw new ToolError(`${name} must be an array of strings`);
  return v;
}

async function run(args: Filters): Promise<Decision> {
  const only = strings(args.only, "only") ?? [];
  const overrides: Partial<Config> = {};
  const exclude = strings(args.exclude, "exclude");
  const prefer = strings(args.prefer, "prefer");
  if (exclude) overrides.exclude = exclude;
  if (prefer) overrides.prefer = prefer;
  if (args.minHeadroom !== undefined) {
    if (typeof args.minHeadroom !== "number") throw new ToolError("minHeadroom must be a number");
    overrides.minHeadroom = args.minHeadroom;
  }
  if (args.refresh) overrides.cacheMs = 0;

  const probes = probesFor(only);
  if (!probes.length) throw new ToolError(`only matched no known CLI (have: ${clis.join(", ")})`);
  return decide(loadConfig(overrides), probes);
}

function pickResult({ winner, ranked, reason }: Decision) {
  const window = winner && tightest(winner);
  return {
    winner: winner
      ? {
          agentId: agentId(winner),
          command: winner.command,
          label: winner.label,
          tier: winner.tier,
          headroom: winner.headroom ?? null,
          window: window ?? null,
          note: winner.note ?? null,
        }
      : null,
    reason: reason ?? "no agent has usable capacity",
    fallbacks: ranked
      .filter((c) => c.eligible && c !== winner)
      .map((c) => ({ agentId: agentId(c), command: c.command, tier: c.tier })),
  };
}

async function callTool(name: string, args: Filters) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return undefined;
  try {
    const decision = await run(args);
    const structured = name === "pick_agent" ? pickResult(decision) : report(decision);
    return {
      content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
      structuredContent: structured,
    };
  } catch (e) {
    return { content: [{ type: "text", text: (e as Error).message }], isError: true };
  }
}

type Id = string | number | null;

function send(msg: object) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

const fail = (id: Id, code: number, message: string) => send({ id, error: { code, message } });

async function handle(msg: { id?: Id; method?: string; params?: any }) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (!isRequest) return; // notifications (initialized, cancelled) need no reply

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      send({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "which-agent-next", version: VERSION },
        },
      });
      return;
    }
    case "ping":
      send({ id, result: {} });
      return;
    case "tools/list":
      send({ id, result: { tools: TOOLS } });
      return;
    case "tools/call": {
      const result = await callTool(params?.name, params?.arguments ?? {});
      if (result) send({ id, result });
      else fail(id, -32602, `unknown tool: ${params?.name}`);
      return;
    }
    default:
      fail(id, -32601, `method not found: ${method}`);
  }
}

// Tool calls run one at a time: concurrent probes would hit the Claude usage
// endpoint in parallel and earn a 429, where a queued call reuses the cache.
let queue = Promise.resolve();

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    fail(null, -32700, "parse error");
    return;
  }
  const go = () => handle(msg).catch((e) => fail(msg?.id ?? null, -32603, (e as Error).message));
  if (msg?.method === "tools/call") queue = queue.then(go);
  else void go();
});
