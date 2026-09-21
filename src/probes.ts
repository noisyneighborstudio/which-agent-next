import { createHash } from "node:crypto";
import { readdirSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache } from "./cache.js";
import type { Candidate, Probe, ProbeContext, UsageWindow } from "./types.js";
import {
  ago, exists, getJson, keychain, mtime, readJson, readTail, until, which,
} from "./util.js";

const HOME = homedir();

function unavailable(
  cli: string, label: string, command: string,
  state: Candidate["state"], note: string,
): Candidate {
  return { id: cli, cli, label, command, state, windows: [], note };
}

/* ------------------------------------------------------------------ claude */

/**
 * Claude Code, once per profile managed by `claudes` (~/.claude-profiles).
 * Quota comes from the same OAuth endpoint the CLI's own /usage screen reads,
 * so it counts usage from the web, desktop and other machines too.
 */
const claudeProbe: Probe = {
  cli: "claude",
  label: "Claude Code",
  preference: 0,
  async run(ctx) {
    if (!which("claude") && !which("claude-as")) return [];
    const root = join(HOME, ".claude-profiles");
    const names = new Set<string>(["Default"]);
    try {
      for (const e of readdirSync(root, { withFileTypes: true }))
        if (e.isDirectory() && !e.name.startsWith(".")) names.add(e.name);
    } catch {
      /* no profile manager installed — just the default config dir */
    }
    // Sequential on purpose: the usage endpoint 429s when several profiles
    // hit it at once, which would report healthy accounts as broken.
    const out: Candidate[] = [];
    for (const n of [...names].sort()) out.push(await claudeProfile(n, root, ctx));
    return out;
  },
};

/** Default lives at ~/.claude unless `claudes use` has symlinked it away. */
function claudeConfigDir(name: string, root: string): string {
  if (name !== "Default") return join(root, name);
  const dot = join(HOME, ".claude");
  try {
    if (lstatSync(dot).isSymbolicLink()) return join(root, "Default");
  } catch {
    /* fall through */
  }
  return exists(join(root, "Default")) && !exists(dot) ? join(root, "Default") : dot;
}

/** `claude-expo` if the shim exists, else `claude-as Expo`, else plain `claude`. */
function claudeCommand(name: string): string {
  const shim = `claude-${name.toLowerCase()}`;
  if (which(shim)) return shim;
  if (which("claude-as")) return `claude-as ${name}`;
  return "claude";
}

async function claudeToken(cfg: string, isDefault: boolean): Promise<
  { token: string } | { error: "stale-token" | "no-token" }
> {
  const services = [
    `Claude Code-credentials-${createHash("sha256").update(cfg).digest("hex").slice(0, 8)}`,
  ];
  if (isDefault) services.unshift("Claude Code-credentials");

  let stale = false;
  const consider = (raw: unknown): string | undefined => {
    const oauth = (raw as any)?.claudeAiOauth;
    if (!oauth?.accessToken) return undefined;
    if ((oauth.expiresAt ?? 0) / 1000 > Date.now() / 1000) return oauth.accessToken;
    stale = true;
    return undefined;
  };

  for (const svc of services) {
    const raw = await keychain(svc);
    if (!raw) continue;
    try {
      const tok = consider(JSON.parse(raw));
      if (tok) return { token: tok };
    } catch {
      /* not JSON — next service */
    }
  }
  const tok = consider(readJson(join(cfg, ".credentials.json")));
  if (tok) return { token: tok };
  return { error: stale ? "stale-token" : "no-token" };
}

/** One retry on 429 — the endpoint is touchy about bursts across profiles. */
async function fetchUsage(token: string): Promise<any> {
  const call = () =>
    getJson<any>(
      "https://api.anthropic.com/api/oauth/usage",
      {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "which-agent-next",
      },
      7000,
    );
  try {
    return await call();
  } catch (e) {
    if (!/\b429\b/.test((e as Error).message)) throw e;
    await new Promise((r) => setTimeout(r, 900));
    return call();
  }
}

async function claudeProfile(name: string, root: string, ctx: ProbeContext): Promise<Candidate> {
  const id = `claude:${name}`;
  const label = `Claude Code (${name})`;
  const command = claudeCommand(name);
  const cfg = claudeConfigDir(name, root);

  const auth = await claudeToken(cfg, name === "Default");
  if ("error" in auth) {
    const note = auth.error === "stale-token"
      ? `token expired — run \`${command}\` once to refresh`
      : `not logged in (${cfg})`;
    return { id, cli: "claude", label, profile: name, command, state: "unauthenticated", windows: [], note };
  }

  const key = `claude:${cfg}`;
  let observedAt: number | undefined;
  let stale: string | undefined;
  try {
    const fresh = readCache<any>(key, ctx.cacheMs);
    let r = fresh?.value;
    if (fresh) {
      observedAt = fresh.at;
    } else {
      try {
        r = await fetchUsage(auth.token);
        writeCache(key, r);
      } catch (e) {
        // A rate-limited usage endpoint shouldn't erase an account we measured
        // moments ago — reuse it, but say out loud how old the reading is.
        const hit = readCache<any>(key, ctx.staleMs);
        if (!hit) throw e;
        r = hit.value;
        observedAt = hit.at;
        stale = `live read failed (${(e as Error).message})`;
      }
    }
    const windows: UsageWindow[] = [];
    for (const [key, lbl] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
      const w = r?.[key];
      if (typeof w?.utilization === "number")
        windows.push({ label: lbl, usedPercent: w.utilization, resetsAt: w.resetsAt ?? w.resets_at });
    }
    if (!windows.length)
      return { id, cli: "claude", label, profile: name, command, state: "unknown", windows, note: "no windows reported" };

    const locked = r?.five_hour?.locked_reason ?? r?.seven_day?.locked_reason;
    const notes = [
      locked ? `locked: ${locked}` : undefined,
      stale,
      observedAt ? `as of ${ago(observedAt)}` : undefined,
    ].filter(Boolean);
    return {
      id, cli: "claude", label, profile: name, command,
      state: "ready",
      windows,
      headroom: 100 - Math.max(...windows.map((w) => w.usedPercent)),
      observedAt,
      note: notes.length ? notes.join(", ") : undefined,
    };
  } catch (e) {
    const msg = (e as Error).message;
    // A throttled usage endpoint says nothing about the account's own quota —
    // don't let it read as "this profile is spent".
    const note = /\b429\b/.test(msg)
      ? "usage endpoint rate-limited (says nothing about account quota) — retry shortly"
      : `usage fetch failed: ${msg}`;
    return { id, cli: "claude", label, profile: name, command, state: "error", windows: [], note };
  }
}

/* ------------------------------------------------------------------- codex */

/**
 * Codex reports its own rate limits on every turn and they land in the session
 * rollout. There is no local endpoint, so we read the newest one back — the
 * numbers are a snapshot from the last request, and we say how old they are.
 */
const codexProbe: Probe = {
  cli: "codex",
  label: "Codex",
  preference: 1,
  async run() {
    if (!which("codex")) return [];
    const home = process.env.CODEX_HOME ?? join(HOME, ".codex");
    if (!exists(join(home, "auth.json")))
      return [unavailable("codex", "Codex", "codex", "unauthenticated", "not logged in — run `codex login`")];

    const found = newestRateLimits(join(home, "sessions"));
    if (!found)
      return [{
        id: "codex", cli: "codex", label: "Codex", command: "codex",
        state: "unknown", windows: [],
        note: "logged in; no rate-limit snapshot in recent sessions yet",
      }];

    const { limits, at } = found;
    const windows: UsageWindow[] = [];
    for (const key of ["primary", "secondary"]) {
      const w = limits?.[key];
      if (typeof w?.used_percent !== "number") continue;
      windows.push({
        label: windowLabel(w.window_minutes),
        usedPercent: w.used_percent,
        resetsAt: typeof w.resets_at === "number"
          ? new Date(w.resets_at * 1000).toISOString()
          : w.resets_at,
      });
    }
    if (!windows.length)
      return [{
        id: "codex", cli: "codex", label: "Codex", command: "codex",
        state: "unknown", windows: [], note: "snapshot had no usable windows",
      }];

    const notes = [`as of ${ago(at)}`];
    if (limits.plan_type) notes.unshift(`plan ${limits.plan_type}`);
    if (limits?.credits?.has_credits) notes.push(`credits ${limits.credits.balance}`);
    return [{
      id: "codex", cli: "codex", label: "Codex", command: "codex",
      state: "ready",
      windows,
      headroom: 100 - Math.max(...windows.map((w) => w.usedPercent)),
      observedAt: at,
      note: notes.join(", "),
    }];
  },
};

export function windowLabel(minutes: unknown): string {
  if (typeof minutes !== "number" || minutes <= 0) return "window";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Newest rollout that actually carries a rate_limits event. */
function newestRateLimits(sessions: string): { limits: any; at: number } | undefined {
  const files = newestFiles(sessions, 8);
  for (const f of files) {
    const limits = lastRateLimits(readTail(f.path));
    if (limits) return { limits, at: f.mtime };
  }
  return undefined;
}

/** The N most recent .jsonl rollouts, walking the YYYY/MM/DD tree newest-first. */
function newestFiles(root: string, n: number): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = [];
  const descend = (dir: string, depth: number) => {
    if (out.length >= n * 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    if (depth < 3) {
      for (const d of dirs) descend(join(dir, d), depth + 1);
      return;
    }
    for (const e of entries)
      if (e.isFile() && e.name.endsWith(".jsonl"))
        out.push({ path: join(dir, e.name), mtime: mtime(join(dir, e.name)) });
  };
  descend(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, n);
}

/** Last `"rate_limits":{…}` object in a chunk of JSONL, brace-matched. */
export function lastRateLimits(text: string): any | undefined {
  const key = '"rate_limits":';
  const start = text.lastIndexOf(key);
  if (start < 0) return undefined;
  let i = text.indexOf("{", start + key.length);
  if (i < 0) return undefined;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(i, j + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/* -------------------------------------------------- token-only CLIs (grok…) */

/** grok stores OIDC sessions keyed by issuer; any unexpired one means ready. */
const grokProbe: Probe = {
  cli: "grok",
  label: "Grok",
  preference: 2,
  async run() {
    if (!which("grok")) return [];
    const auth = readJson<Record<string, any>>(join(HOME, ".grok", "auth.json"));
    const sessions = Object.values(auth ?? {}).filter((v) => v?.key);
    if (!sessions.length)
      return [unavailable("grok", "Grok", "grok", "unauthenticated", "not logged in — run `grok login`")];
    const live = sessions.find((s) => !s.expires_at || Date.parse(s.expires_at) > Date.now());
    const who = (live ?? sessions[0]).email;
    return [{
      id: "grok", cli: "grok", label: "Grok", command: "grok",
      state: "unknown",
      windows: [],
      note: live
        ? `signed in${who ? ` as ${who}` : ""}; no quota API exposed`
        : "session expired — run `grok login`",
      ...(live ? {} : { state: "unauthenticated" as const }),
    }];
  },
};

const geminiProbe: Probe = {
  cli: "gemini",
  label: "Gemini CLI",
  preference: 3,
  async run() {
    if (!which("gemini")) return [];
    const dir = join(HOME, ".gemini");
    const oauth = readJson<any>(join(dir, "oauth_creds.json"));
    const hasKey = Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
    if (!oauth?.access_token && !hasKey)
      return [unavailable("gemini", "Gemini CLI", "gemini", "unauthenticated", "not logged in — run `gemini` and sign in")];
    const acct = readJson<any>(join(dir, "google_accounts.json"));
    const who = acct?.active ?? Object.keys(acct ?? {})[0];
    return [{
      id: "gemini", cli: "gemini", label: "Gemini CLI", command: "gemini",
      state: "unknown",
      windows: [],
      note: `${hasKey ? "API key" : `signed in${who ? ` as ${who}` : ""}`}; no quota API exposed`,
    }];
  },
};

const cursorProbe: Probe = {
  cli: "cursor-agent",
  label: "Cursor Agent",
  preference: 4,
  async run() {
    if (!which("cursor-agent")) return [];
    // Cursor keeps no readable CLI credential; `cursor-agent status` would
    // start an interactive login, so absence of a token file is the signal.
    const cfg = readJson<any>(join(HOME, ".cursor", "cli-config.json"));
    const token = cfg?.accessToken ?? cfg?.token ?? (await keychain("cursor-agent"));
    if (!token)
      return [unavailable(
        "cursor-agent", "Cursor Agent", "cursor-agent", "unauthenticated",
        "no CLI credentials found — run `cursor-agent login`",
      )];
    return [{
      id: "cursor-agent", cli: "cursor-agent", label: "Cursor Agent", command: "cursor-agent",
      state: "unknown", windows: [], note: "signed in; no quota API exposed",
    }];
  },
};

const opencodeProbe: Probe = {
  cli: "opencode",
  label: "opencode",
  preference: 5,
  async run() {
    if (!which("opencode")) return [];
    const auth = readJson<Record<string, any>>(join(HOME, ".local", "share", "opencode", "auth.json"));
    const providers = Object.keys(auth ?? {});
    if (!providers.length)
      return [unavailable("opencode", "opencode", "opencode", "unauthenticated", "no providers configured — run `opencode auth login`")];
    return [{
      id: "opencode", cli: "opencode", label: "opencode", command: "opencode",
      state: "unknown", windows: [],
      note: `providers: ${providers.join(", ")}; quota is per upstream provider`,
    }];
  },
};

/**
 * Muse Code (Meta). The Meta-account token lives in the keychain; auth.json
 * only records who signed in. Sessions log token counts, never a quota.
 */
const museProbe: Probe = {
  cli: "muse",
  label: "Muse Code",
  preference: 6,
  async run() {
    if (!which("muse")) return [];
    const path = process.env.MUSE_AUTH_PATH
      ?? join(process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), "muse", "auth.json");
    const meta = readJson<any>(path)?.providers?.meta;
    const hasKey = Boolean(process.env.META_API_KEY);
    if (!meta && !hasKey)
      return [unavailable("muse", "Muse Code", "muse", "unauthenticated", "not logged in — run `muse login`")];
    const who = meta?.user_email;
    return [{
      id: "muse", cli: "muse", label: "Muse Code", command: "muse",
      state: "unknown",
      windows: [],
      note: `${hasKey ? "API key" : `signed in${who ? ` as ${who}` : ""}`}; no quota API exposed`,
    }];
  },
};

/** Local models have no quota at all — the always-available last resort. */
const ollamaProbe: Probe = {
  cli: "ollama",
  label: "Ollama (local)",
  preference: 9,
  async run() {
    if (!which("ollama")) return [];
    const host = (process.env.OLLAMA_HOST ?? "127.0.0.1:11434").replace(/^https?:\/\//, "");
    try {
      const r = await getJson<any>(`http://${host}/api/tags`, {}, 1500);
      const models: string[] = (r?.models ?? []).map((m: any) => m.name);
      if (!models.length)
        return [unavailable("ollama", "Ollama (local)", "ollama", "unauthenticated", "no models pulled — run `ollama pull <model>`")];
      return [{
        id: "ollama", cli: "ollama", label: "Ollama (local)",
        command: `ollama run ${models[0]}`,
        state: "unmetered", windows: [],
        note: `${models.length} local model${models.length > 1 ? "s" : ""}, no quota`,
      }];
    } catch {
      return [unavailable("ollama", "Ollama (local)", "ollama", "error", "daemon not reachable — run `ollama serve`")];
    }
  },
};

export const PROBES: Probe[] = [
  claudeProbe, codexProbe, grokProbe, geminiProbe, cursorProbe, opencodeProbe, museProbe, ollamaProbe,
];

export { until };
