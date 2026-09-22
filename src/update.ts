import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readCache, writeCache } from "./cache.js";
import { exists, getJson, withTimeout } from "./util.js";

const PKG = (() => {
  try {
    return createRequire(import.meta.url)("../package.json") as { name: string; version: string };
  } catch {
    return { name: "@sethwebster/which-agent-next", version: "0.0.0" };
  }
})();

export const VERSION = PKG.version;

const KEY = "update:latest";
const DAY = 24 * 60 * 60_000;

/** True when `a` is a newer x.y.z than `b`. Prerelease tags are ignored. */
export function newer(a: string, b: string): boolean {
  const n = (v: string) => v.split("-")[0]!.split(".").map(Number);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * Starts the once-a-day registry check and returns the notice step. The check
 * overlaps the probes, so it rarely adds latency. Silent unless a human is
 * watching stderr: scripts, CI and loop agents (CI=1) parse our output.
 */
export function startUpdateCheck(): () => Promise<void> {
  const env = process.env;
  if (!process.stderr.isTTY || env.CI || env.NO_UPDATE_NOTIFIER) return async () => {};
  const pending = readCache<string>(KEY, DAY)
    ? Promise.resolve()
    : getJson<{ version: string }>(`https://registry.npmjs.org/${PKG.name.replace("/", "%2f")}/latest`, {}, 3000)
        .then((r) => writeCache(KEY, r.version))
        .catch(() => {}); // offline: nothing to announce; retried next run
  return async () => {
    // A slow or offline registry must never hold the answer hostage.
    await withTimeout(pending, 1500, undefined);
    const latest = readCache<string>(KEY, DAY)?.value;
    if (latest && newer(latest, VERSION))
      console.error(`\nwan ${latest} is available (you have ${VERSION}) — run \`wan upgrade\``);
  };
}

/** `wan upgrade`: reinstall through the npm that owns this global install. */
export function upgrade(): number {
  const npm = join(dirname(process.execPath), "npm");
  const prefix = dirname(dirname(process.execPath));
  const installed = join(prefix, "lib", "node_modules", PKG.name) + sep;
  const self = realpathSync(fileURLToPath(import.meta.url));
  if (!self.startsWith(installed) || !exists(npm)) {
    console.error(
      `wan: not a global npm install of this node (${self}).\n` +
      `Upgrade it the way it was installed, or: npm install -g ${PKG.name}@latest`,
    );
    return 1;
  }
  console.error(`wan: ${npm} install -g ${PKG.name}@latest`);
  const r = spawnSync(npm, ["install", "-g", `${PKG.name}@latest`], { stdio: "inherit" });
  if (r.status !== 0) return r.status ?? 1;
  const now = spawnSync(join(prefix, "bin", "wan"), ["--version"], { encoding: "utf8" }).stdout.trim();
  console.error(now === VERSION ? `wan: already on ${VERSION}` : `wan: upgraded ${VERSION} → ${now}`);
  writeCache(KEY, now);
  return 0;
}
