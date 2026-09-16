import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, pick, tierOf, tightest, preferenceOf } from "../dist/rank.js";
import { DEFAULT_CONFIG } from "../dist/types.js";

const probes = [
  { cli: "claude", label: "Claude", preference: 0, run: async () => [] },
  { cli: "codex", label: "Codex", preference: 1, run: async () => [] },
  { cli: "grok", label: "Grok", preference: 2, run: async () => [] },
  { cli: "ollama", label: "Ollama", preference: 9, run: async () => [] },
];

const cfg = (over = {}) => ({ ...DEFAULT_CONFIG, ...over });

const ready = (id, cli, headroom) => ({
  id, cli, label: id, command: id, state: "ready",
  windows: [{ label: "7d", usedPercent: 100 - headroom }],
  headroom,
});
const plain = (id, cli, state) => ({ id, cli, label: id, command: id, state, windows: [] });

test("tiers bucket by remaining headroom", () => {
  assert.equal(tierOf(ready("a", "claude", 90), 5), "plenty");
  assert.equal(tierOf(ready("a", "claude", 50), 5), "plenty");
  assert.equal(tierOf(ready("a", "claude", 49), 5), "ok");
  assert.equal(tierOf(ready("a", "claude", 20), 5), "ok");
  assert.equal(tierOf(ready("a", "claude", 19), 5), "low");
  assert.equal(tierOf(ready("a", "claude", 4), 5), "exhausted");
  assert.equal(tierOf(plain("a", "grok", "unknown"), 5), "unknown");
  assert.equal(tierOf(plain("a", "ollama", "unmetered"), 5), "local");
  assert.equal(tierOf(plain("a", "x", "unauthenticated"), 5), undefined);
  assert.equal(tierOf(plain("a", "x", "error"), 5), undefined);
});

test("a stronger agent is not demoted over a few percent inside a tier", () => {
  // Codex has more left, but both are 'plenty' so preference decides.
  const r = rank([ready("codex", "codex", 95), ready("claude", "claude", 60)], probes, cfg());
  assert.equal(pick(r).id, "claude");
});

test("a real tier gap does override preference", () => {
  const r = rank([ready("codex", "codex", 95), ready("claude", "claude", 30)], probes, cfg());
  assert.equal(pick(r).id, "codex");
});

test("measured-and-healthy beats unknown, unknown beats nearly-spent", () => {
  const r = rank(
    [plain("grok", "grok", "unknown"), ready("claude", "claude", 8), ready("codex", "codex", 40)],
    probes, cfg(),
  );
  assert.deepEqual(r.map((c) => c.id), ["codex", "grok", "claude"]);
});

test("local models are the last resort, never the default pick", () => {
  const withOthers = rank([plain("ollama", "ollama", "unmetered"), plain("grok", "grok", "unknown")], probes, cfg());
  assert.equal(pick(withOthers).id, "grok");
  const alone = rank([plain("ollama", "ollama", "unmetered")], probes, cfg());
  assert.equal(pick(alone).id, "ollama");
});

test("exhausted and unauthenticated are never picked", () => {
  const r = rank([ready("claude", "claude", 1), plain("codex", "codex", "unauthenticated")], probes, cfg());
  assert.equal(pick(r), undefined);
  assert.equal(r.every((c) => !c.eligible), true);
});

test("min-headroom is configurable", () => {
  assert.equal(pick(rank([ready("a", "claude", 8)], probes, cfg({ minHeadroom: 5 }))).id, "a");
  assert.equal(pick(rank([ready("a", "claude", 8)], probes, cfg({ minHeadroom: 10 }))), undefined);
});

test("exclude drops a cli or a single candidate id", () => {
  const cands = [ready("claude:Work", "claude", 90), ready("codex", "codex", 80)];
  assert.equal(pick(rank(cands, probes, cfg({ exclude: ["claude"] }))).id, "codex");
  assert.equal(pick(rank(cands, probes, cfg({ exclude: ["claude:Work"] }))).id, "codex");
});

test("prefer overrides built-in order and beats unlisted clis", () => {
  const c = cfg({ prefer: ["grok"] });
  assert.equal(preferenceOf("grok", probes, c.prefer), 0);
  assert.ok(preferenceOf("claude", probes, c.prefer) > 0);
  const r = rank([ready("claude", "claude", 90), ready("grok", "grok", 90)], probes, c);
  assert.equal(pick(r).id, "grok");
});

test("headroom comes from the window closest to being spent", () => {
  const c = {
    id: "x", cli: "claude", label: "x", command: "x", state: "ready",
    windows: [{ label: "5h", usedPercent: 2 }, { label: "7d", usedPercent: 91 }],
    headroom: 9,
  };
  assert.equal(tightest(c).label, "7d");
  assert.equal(tierOf(c, 5), "low");
});

test("agent ids name the cli, and the profile when the cli has one", async () => {
  const { agentId } = await import("../dist/rank.js");
  assert.equal(agentId({ cli: "codex" }), "codex");
  assert.equal(agentId({ cli: "claude", profile: "Default" }), "claude|Default");
  assert.equal(agentId({ cli: "claude", profile: "ExpoIO" }), "claude|ExpoIO");
  // Format tracks whether the CLI has profiles at all, not how many exist,
  // so adding or removing one never changes an existing id.
  assert.equal(agentId({ cli: "ollama" }), "ollama");
});

test("passthrough args survive being printed as a command line", async () => {
  const { shellQuote } = await import("../dist/util.js");
  assert.equal(shellQuote("-p"), "-p");
  assert.equal(shellQuote("review this"), "'review this'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("--model=opus"), "--model=opus");
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
});
