import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "wan-update-"));
delete process.env.CI;
delete process.env.NO_UPDATE_NOTIFIER;

const { newer, startUpdateCheck, upgrade, VERSION } = await import("../dist/update.js");
const { writeCache } = await import("../dist/cache.js");

/** Run `fn` with stderr posing as a terminal, returning what it printed. */
async function stderrOf(fn, tty = true) {
  const [was, log] = [process.stderr.isTTY, console.error];
  const out = [];
  process.stderr.isTTY = tty;
  console.error = (...a) => out.push(a.join(" "));
  try {
    await fn();
  } finally {
    process.stderr.isTTY = was;
    console.error = log;
  }
  return out.join("\n");
}

test("newer compares x.y.z numerically, not as strings", () => {
  assert.equal(newer("0.10.0", "0.9.9"), true);
  assert.equal(newer("1.0.0", "0.99.99"), true);
  assert.equal(newer("0.4.1", "0.4.0"), true);
  assert.equal(newer("0.4.0", "0.4.0"), false);
  assert.equal(newer("0.3.9", "0.4.0"), false);
  assert.equal(newer("0.5.0-beta.1", "0.4.0"), true);
});

test("a newer cached release is announced once the command is done", async () => {
  writeCache("update:latest", "99.0.0");
  const out = await stderrOf(async () => (await startUpdateCheck())());
  assert.match(out, new RegExp(`wan 99\\.0\\.0 is available \\(you have ${VERSION.replace(/\./g, "\\.")}\\) — run \`wan upgrade\``));
});

test("the current release is not announced", async () => {
  writeCache("update:latest", VERSION);
  assert.equal(await stderrOf(async () => (await startUpdateCheck())()), "");
});

test("scripts, CI and opted-out users never see the notice", async () => {
  writeCache("update:latest", "99.0.0");
  assert.equal(await stderrOf(async () => (await startUpdateCheck())(), false), "", "stderr is not a terminal");
  for (const key of ["CI", "NO_UPDATE_NOTIFIER"]) {
    process.env[key] = "1";
    try {
      assert.equal(await stderrOf(async () => (await startUpdateCheck())()), "", key);
    } finally {
      delete process.env[key];
    }
  }
});

test("upgrade refuses to guess when this is not a global npm install", async () => {
  // Tests run from the source checkout's dist/, never a global install.
  let code;
  const out = await stderrOf(() => { code = upgrade(); });
  assert.equal(code, 1);
  assert.match(out, /not a global npm install/);
  assert.match(out, /npm install -g @sethwebster\/which-agent-next@latest/);
});
