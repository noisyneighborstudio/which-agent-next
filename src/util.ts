import { execFile } from "node:child_process";
import { accessSync, constants, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

/** Absolute path of `bin` on PATH, or undefined. Mirrors `command -v`. */
export function which(bin: string): string | undefined {
  if (isAbsolute(bin)) return executable(bin) ? bin : undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, bin);
    if (executable(full)) return full;
  }
  return undefined;
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function readJson<T = any>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Read the last `bytes` of a file without loading the whole thing — session
 * rollouts run to hundreds of megabytes and we only want the newest events.
 */
export function readTail(path: string, bytes = 256 * 1024): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A macOS Keychain generic password, or undefined when absent. */
export async function keychain(service: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { maxBuffer: 1 << 22 },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function getJson<T = any>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve with `fallback` if `p` hasn't settled within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** "3m ago", "2h ago" — staleness for cached quota reads. */
export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** "in 2h 14m" until an ISO timestamp or epoch-seconds reset point. */
export function until(when?: string | number): string | undefined {
  if (when === undefined) return undefined;
  const t = typeof when === "number" ? when * 1000 : Date.parse(when);
  if (!Number.isFinite(t)) return undefined;
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 48) return m ? `in ${h}h ${m}m` : `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/** POSIX single-quoting, so a printed command line survives copy-paste. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) && arg.length
    ? arg
    : `'${arg.replace(/'/g, `'\\''`)}'`;
}
