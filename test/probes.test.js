import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "wan-cache-"));

const { lastRateLimits, windowLabel, PROBES } = await import("../dist/probes.js");
const { readCache, writeCache } = await import("../dist/cache.js");

test("lastRateLimits pulls the newest snapshot out of a rollout tail", () => {
  const tail = [
    '{"type":"token_count","info":{"rate_limits":{"primary":{"used_percent":10.0,"window_minutes":300}}}}',
    '{"type":"message","text":"a brace { and a quoted \\" quote"}',
    '{"type":"token_count","info":{"rate_limits":{"limit_id":"codex","primary":{"used_percent":91.0,"window_minutes":10080,"resets_at":1789805387},"secondary":null,"plan_type":"pro"}}}',
  ].join("\n");
  const r = lastRateLimits(tail);
  assert.equal(r.primary.used_percent, 91);
  assert.equal(r.plan_type, "pro");
});

test("lastRateLimits survives a tail sliced mid-object", () => {
  assert.equal(lastRateLimits('percent":50}}}\n{"type":"x"}'), undefined);
  assert.equal(lastRateLimits('{"rate_limits":{"primary":{"used'), undefined);
  assert.equal(lastRateLimits("no snapshot here"), undefined);
});

test("window labels read the way a human would say them", () => {
  assert.equal(windowLabel(300), "5h");
  assert.equal(windowLabel(10080), "7d");
  assert.equal(windowLabel(1440), "1d");
  assert.equal(windowLabel(45), "45m");
  assert.equal(windowLabel(null), "window");
});

test("cache serves fresh reads and withholds expired ones", () => {
  writeCache("k", { five_hour: { utilization: 1 } });
  assert.equal(readCache("k", 60_000).value.five_hour.utilization, 1);
  assert.equal(readCache("k", 0), undefined, "cacheMs 0 forces a live fetch");
  assert.equal(readCache("missing", 60_000), undefined);
});

test("a stale entry is still reachable inside the wider stale window", async () => {
  writeCache("old", { v: 1 });
  const { readCache: rc } = await import("../dist/cache.js");
  const entry = rc("old", 30 * 60_000);
  assert.ok(entry && Date.now() - entry.at < 30 * 60_000);
  // …but not once it ages past that window.
  assert.equal(rc("old", -1), undefined);
});

test("muse reads its sign-in from auth.json and reports no quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wan-muse-"));
  writeFileSync(join(dir, "muse"), "#!/bin/sh\n");
  chmodSync(join(dir, "muse"), 0o755);
  const auth = join(dir, "auth.json");
  const saved = { PATH: process.env.PATH, MUSE_AUTH_PATH: process.env.MUSE_AUTH_PATH, META_API_KEY: process.env.META_API_KEY };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.MUSE_AUTH_PATH = auth;
  delete process.env.META_API_KEY;
  const muse = PROBES.find((p) => p.cli === "muse");
  try {
    let [c] = await muse.run({ cacheMs: 0, staleMs: 0 });
    assert.equal(c.state, "unauthenticated");
    assert.match(c.note, /muse login/);

    writeFileSync(auth, JSON.stringify({ providers: { meta: { mechanism: "oauth", user_email: "a@b.c" } } }));
    [c] = await muse.run({ cacheMs: 0, staleMs: 0 });
    assert.equal(c.state, "unknown");
    assert.equal(c.command, "muse");
    assert.match(c.note, /signed in as a@b\.c; no quota API/);

    writeFileSync(auth, "{}");
    process.env.META_API_KEY = "k";
    [c] = await muse.run({ cacheMs: 0, staleMs: 0 });
    assert.equal(c.state, "unknown");
    assert.match(c.note, /^API key/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
