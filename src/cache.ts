import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJson } from "./util.js";

/**
 * Tiny on-disk cache for quota reads. The Anthropic usage endpoint rate-limits
 * a chatty caller, and this tool is meant to be run constantly (shell prompts,
 * scripts, pre-flight checks) — so a fresh-enough answer beats a 429.
 */
export interface CacheEntry<T = unknown> {
  at: number;
  value: T;
}

export function cacheFile(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "which-agent-next", "usage.json");
}

type Store = Record<string, CacheEntry>;

function load(): Store {
  return readJson<Store>(cacheFile()) ?? {};
}

/** Cached value for `key` if it is younger than `maxAgeMs`. */
export function readCache<T>(key: string, maxAgeMs: number): CacheEntry<T> | undefined {
  if (maxAgeMs <= 0) return undefined;
  const hit = load()[key] as CacheEntry<T> | undefined;
  return hit && Date.now() - hit.at <= maxAgeMs ? hit : undefined;
}

export function writeCache(key: string, value: unknown): void {
  const path = cacheFile();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const store = load();
    store[key] = { at: Date.now(), value };
    writeFileSync(path, JSON.stringify(store), { mode: 0o600 });
  } catch {
    /* a cache that can't be written is not an error worth failing over */
  }
}
