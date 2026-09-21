import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterFor,
  BOT_GH_LOGIN,
  BOT_GIT_NAME,
  MAX_PATCH_BYTES,
  MAX_TIMEOUT_MS,
  ROLES,
  SOFT_CHECKPOINT_MS,
  artifactRevision,
  assertAdapterFlags,
  changePatch,
  childEnv,
  createWorktree,
  defaultGitTools,
  gitRevision,
  inspectChanges,
  integrateWorktree,
  invokeAgent,
  nextRetryAt,
  parseAgentReport,
  pathAllowed,
  processAlive,
  processGroupId,
  processSignature,
  resetFlagCache,
  runCommand,
  selectProvider,
  serviceDefinition,
  snapshotWorkspace,
  splitCommand,
  supportedRoles,
  terminateOwnedProcess,
  unsupportedReason,
  verifyBotIdentity,
} from "../dist/loop/runtime.js";

const tmp = (prefix) => mkdtempSync(join(tmpdir(), `wan-${prefix}-`));

/** A stand-in for an agent CLI: ignores argv, echoes stdin, obeys a script. */
function fixtureCli(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Every flag the claude adapter demands of the installed build. */
const CLAUDE_HELP = [
  "  -p, --print",
  "  --output-format <format>",
  "  --strict-mcp-config",
  "  --permission-mode <mode>",
  "  --permission-prompts <target>",
  "  --tools <tools...>",
  "  --allowedTools <tools...>",
].join("\\n");

/** A fixture that answers `--help` before doing anything else. */
function fixtureCliWithHelp(dir, name, help, body) {
  // %b so the \n sequences in `help` become real lines.
  return fixtureCli(dir, name, `case " $* " in *" --help "*) printf '%b\\n' "${help}"; exit 0;; esac\n${body}`);
}

const provider = (command, cli = "claude") => ({ id: `${cli}|test`, cli, command });

/** Fixture CLIs are not real agents; the flag audit is exercised separately. */
const unverified = { verifyFlags: false };

// ---------------------------------------------------------------------------
// parseAgentReport
// ---------------------------------------------------------------------------

test("the last WAN_RESULT marker wins over earlier ones", () => {
  const text = [
    "thinking out loud",
    'WAN_RESULT {"status":"partial","step":1}',
    "more work happened",
    'WAN_RESULT {"status":"complete","step":2}',
    "trailing chatter",
  ].join("\n");
  assert.deepEqual(parseAgentReport(text), { status: "complete", step: 2 });
});

test("a marker payload spanning lines and containing braces in strings parses", () => {
  const text = 'preamble\nWAN_RESULT {\n  "note": "used } and { in prose",\n  "files": ["a.ts"]\n}\ndone.';
  assert.deepEqual(parseAgentReport(text), { note: "used } and { in prose", files: ["a.ts"] });
});

test("fenced JSON is accepted when no marker is present", () => {
  const text = "Here is the report:\n\n```json\n{\"ok\": true}\n```\n";
  assert.deepEqual(parseAgentReport(text), { ok: true });
});

test("a bare JSON document is accepted", () => {
  assert.deepEqual(parseAgentReport('  {"ok": false, "why": "tests failed"}  '), { ok: false, why: "tests failed" });
});

test("a provider envelope is unwrapped to the inner report", () => {
  const envelope = JSON.stringify({ type: "result", subtype: "success", result: 'WAN_RESULT {"status":"complete"}' });
  assert.deepEqual(parseAgentReport(envelope), { status: "complete" });
});

test("an envelope whose payload is only prose is kept, not invented", () => {
  const envelope = JSON.stringify({ type: "result", result: "I finished the task." });
  assert.deepEqual(parseAgentReport(envelope), { type: "result", result: "I finished the task." });
});

test("prose is never a report", () => {
  for (const prose of ["done", "Done! All tests pass.", "WAN_RESULT: complete", ""]) {
    assert.throws(() => parseAgentReport(prose), /report|JSON|empty/i, `accepted prose: ${JSON.stringify(prose)}`);
  }
});

test("a marker with a non-object or missing payload is a clear error", () => {
  assert.throws(() => parseAgentReport('WAN_RESULT "complete"'), /no JSON object after it/);
  assert.throws(() => parseAgentReport("WAN_RESULT {broken"), /no JSON object after it/);
  assert.throws(() => parseAgentReport('WAN_RESULT ["a","b"]'), /not a JSON object/);
});

// ---------------------------------------------------------------------------
// splitCommand
// ---------------------------------------------------------------------------

test("provider commands are tokenised like a shell, without being run by one", () => {
  assert.deepEqual(splitCommand("claude"), ["claude"]);
  assert.deepEqual(splitCommand("  claude   --profile  Expo "), ["claude", "--profile", "Expo"]);
  assert.deepEqual(splitCommand("'/Users/a b/bin/claude' --profile Expo"), ["/Users/a b/bin/claude", "--profile", "Expo"]);
  assert.deepEqual(splitCommand('"/Users/a b/bin/claude" --name "my agent"'), ["/Users/a b/bin/claude", "--name", "my agent"]);
  assert.deepEqual(splitCommand("/opt/bin/codex --flag=a,b/c.d"), ["/opt/bin/codex", "--flag=a,b/c.d"]);
  assert.deepEqual(splitCommand("/usr/bin/env\\ weird"), ["/usr/bin/env weird"]);
  // A double-quoted backslash escape survives as one literal character.
  assert.deepEqual(splitCommand('cli "a\\"b"'), ["cli", 'a"b']);
  // An empty quoted token is still a token.
  assert.deepEqual(splitCommand("cli ''"), ["cli", ""]);
});

test("provider commands needing real shell semantics are rejected, not approximated", () => {
  for (const bad of [
    "claude && rm -rf /",
    "claude | tee log",
    "claude; echo pwned",
    "claude $(whoami)",
    "claude `whoami`",
    "claude > out.txt",
    "claude *.ts",
    "~/bin/claude",
    "claude 'unterminated",
    'claude "unterminated',
    "claude trailing\\",
  ]) {
    assert.throws(() => splitCommand(bad), /unsupported shell syntax/, `accepted: ${bad}`);
  }
  assert.throws(() => splitCommand("   "), /empty/);
});

// ---------------------------------------------------------------------------
// roles and adapters
// ---------------------------------------------------------------------------

test("planner and coordinator are first-class read-only roles", () => {
  assert.deepEqual([...ROLES], ["worker", "planner", "verifier", "coordinator", "supervisor"]);
  assert.deepEqual(supportedRoles("claude"), ["worker", "planner", "verifier", "coordinator", "supervisor"]);
  assert.deepEqual(supportedRoles("codex"), ["worker", "planner", "verifier", "coordinator", "supervisor"]);
});

test("all Claude roles delegate approvals to its native auto mode", async () => {
  const dir = tmp("native-approval");
  const seen = join(dir, "argv.txt");
  const cli = fixtureCli(dir, "fake-claude", `printf '%s\\n' "$*" > ${JSON.stringify(seen)}; cat > /dev/null; echo ok`);
  for (const role of ROLES) {
    await invokeAgent({ ...unverified, provider: provider(cli), cwd: dir, prompt: "Follow the approved role contract.", logPath: join(dir, "l"), timeoutMs: 10000, role });
    const argv = readFileSync(seen, "utf8");
    assert.match(argv, /--permission-mode auto/);
    assert.doesNotMatch(argv, /--tools|--allowedTools|--disallowedTools|--permission-prompts|--strict-mcp-config|bypass|dontAsk/);
  }
});

test("all Codex roles delegate approvals to native automatic review", () => {
  for (const role of ROLES) {
    const args = adapterFor('codex').args(role);
    assert.ok(args.includes('--approve-for-me'));
    assert.ok(!args.includes('--sandbox'));
    assert.ok(!args.some(arg => arg.includes('dangerously')));
  }
});

test("muse gets its prompt from an owner-only file, with the approval judge on", async () => {
  const dir = tmp("muse");
  const seen = join(dir, "argv.txt");
  // Echo back the prompt file's contents so the round trip is proven.
  const cli = fixtureCli(dir, "fake-muse", `printf '%s\\n' "$*" > ${JSON.stringify(seen)}; while [ "$1" != --prompt-file ]; do shift; done; cat "$2"`);
  const logPath = join(dir, "l");
  const r = await invokeAgent({ ...unverified, provider: provider(cli, "muse"), cwd: dir, prompt: "the prompt", logPath, timeoutMs: 10000, role: "worker" });
  assert.match(r.text, /the prompt/);
  const argv = readFileSync(seen, "utf8");
  assert.match(argv, /^exec --approval-judge on --user-input-auto-resolve --prompt-file \//);
  assert.doesNotMatch(argv, /--yolo|--disable-approval|--disable-sandbox|the prompt/);
  assert.equal(statSync(`${logPath}.prompt`).mode & 0o777, 0o600);
  assert.deepEqual(supportedRoles("muse"), [...ROLES]);
});

test("adapters only claim what a verified flag can back", () => {
  // opencode run has no flag that removes write and shell tools.
  assert.deepEqual(supportedRoles("opencode"), [...ROLES]);
  assert.equal(unsupportedReason("opencode", "verifier"), undefined);
  // gemini offers --yolo or an approval prompt nobody is there to answer.
  assert.deepEqual(supportedRoles("gemini"), []);
  assert.match(unsupportedReason("gemini", "worker"), /only --yolo/);
  assert.match(unsupportedReason("gemini", "verifier"), /no verified scoped approval flag/);
  assert.deepEqual(supportedRoles("grok"), []);
  assert.match(unsupportedReason("grok", "worker"), /not a supported adapter/);
  assert.equal(unsupportedReason("claude", "coordinator"), undefined);
  assert.match(unsupportedReason("claude", "nonsense"), /unknown role/);
});

test("the flag audit reads the installed build's --help and refuses a build that lacks them", async () => {
  resetFlagCache();
  const dir = tmp("flags");
  const good = fixtureCliWithHelp(dir, "good-claude", CLAUDE_HELP, "cat > /dev/null; echo hi");
  await assertAdapterFlags(provider(good), "verifier");

  const stale = fixtureCliWithHelp(dir, "stale-claude", "  -p, --print\\n  --output-format <format>", "echo hi");
  await assert.rejects(
    () => assertAdapterFlags(provider(stale), "verifier"),
    /does not advertise .*--permission-mode.*checked/s,
    "a build without the native approval mode must be upgraded",
  );

  // invokeAgent performs the same audit by default.
  await assert.rejects(
    () => invokeAgent({ provider: provider(stale), cwd: dir, prompt: "x", logPath: join(dir, "l"), timeoutMs: 5_000, role: "verifier" }),
    /does not advertise/,
  );
  const ok = await invokeAgent({ provider: provider(good), cwd: dir, prompt: "x", logPath: join(dir, "l"), timeoutMs: 10_000, role: "verifier" });
  assert.equal(ok.exitCode, 0);
});

test("the real installed claude advertises every flag its read-only role depends on", async (t) => {
  const { which } = await import("../dist/util.js");
  const bin = which("claude");
  if (!bin) return t.skip("claude is not installed on this host");
  resetFlagCache();
  await assertAdapterFlags({ id: "claude", cli: "claude", command: bin }, "coordinator");
  await assertAdapterFlags({ id: "claude", cli: "claude", command: bin }, "worker");
});

test("the real installed muse advertises every flag its adapter depends on", async (t) => {
  const { which } = await import("../dist/util.js");
  const bin = which("muse");
  if (!bin) return t.skip("muse is not installed on this host");
  resetFlagCache();
  await assertAdapterFlags({ id: "muse", cli: "muse", command: bin }, "worker");
});

test("Claude read-only roles run on builds without the optional permission-prompts flag", async () => {
  const dir = tmp('claude-portable-permissions');
  const seen = join(dir, 'argv.txt');
  const help = CLAUDE_HELP.replace('  --permission-prompts <target>\\n', '');
  const cli = fixtureCliWithHelp(dir, 'claude-default', help,
    `printf '%s\\n' "$*" > ${JSON.stringify(seen)}; cat > /dev/null; echo 'WAN_RESULT {"ok":true}'`);
  for (const role of ['planner', 'coordinator', 'verifier', 'supervisor']) {
    const result = await invokeAgent({ provider: provider(cli), cwd: dir, prompt: 'Read only.', logPath: join(dir, role + '.log'), timeoutMs: 10000, role });
    assert.equal(result.exitCode, 0);
    const args = readFileSync(seen, 'utf8');
    assert.match(args, /--permission-mode auto/);
    assert.doesNotMatch(args, /--permission-prompts|\bBash\b|\b(Edit|Write|NotebookEdit)\b/);
    assert.doesNotMatch(args, /--tools|--allowedTools|--strict-mcp-config/);
  }
});

// ---------------------------------------------------------------------------
// invokeAgent — real children, real timeouts
// ---------------------------------------------------------------------------

test("the prompt reaches the child on stdin and its output comes back", async () => {
  const dir = tmp("invoke");
  const cli = fixtureCli(dir, "fake-claude", 'cat; echo; echo \'WAN_RESULT {"status":"complete"}\'');
  let spawnedPid;
  let signature;
  const res = await invokeAgent({
    ...unverified,
    provider: provider(cli),
    cwd: dir,
    prompt: "summarise the diff",
    logPath: join(dir, "logs", "agent.log"),
    timeoutMs: 10_000,
    role: "worker",
    onSpawn: (pid) => (spawnedPid = pid),
    onSignature: (_pid, sig) => (signature = sig),
  });

  assert.equal(res.exitCode, 0);
  assert.equal(res.timedOut, false);
  assert.match(res.text, /summarise the diff/);
  assert.deepEqual(parseAgentReport(res.text), { status: "complete" });
  assert.equal(spawnedPid, res.pid, "onSpawn must fire with the real pid");
  if (signature) assert.equal(res.signature, signature, "the recorded signature must be the one reported");
  assert.match(readFileSync(join(dir, "logs", "agent.log"), "utf8"), /summarise the diff/);
});

test("the log file is created with owner-only permissions", async () => {
  const dir = tmp("perm");
  const cli = fixtureCli(dir, "fake-claude", "cat > /dev/null; echo hi");
  const logPath = join(dir, "nested", "agent.log");
  await invokeAgent({ ...unverified, provider: provider(cli), cwd: dir, prompt: "x", logPath, timeoutMs: 10_000, role: "verifier" });
  assert.equal(statSync(logPath).mode & 0o077, 0, "transcript must not be group/world readable");
});

test("timeoutMs must be a real duration", async () => {
  const dir = tmp("badtimeout");
  const cli = fixtureCli(dir, "fake-claude", "echo hi");
  for (const bad of [NaN, 0, -1, Infinity, undefined, "10000"]) {
    await assert.rejects(
      () => invokeAgent({ ...unverified, provider: provider(cli), cwd: dir, prompt: "x", logPath: join(dir, "l"), timeoutMs: bad, role: "worker" }),
      /finite positive number/,
      `accepted timeoutMs=${String(bad)}`,
    );
  }
});

test("a timeout kills the whole process group, not just the child", async () => {
  const dir = tmp("timeout");
  const pidFile = join(dir, "grandchild.pid");
  // The child spawns a grandchild and both outlive the timeout unless the
  // group is signalled.
  const cli = fixtureCli(dir, "fake-claude", `sleep 30 &\necho $! > ${JSON.stringify(pidFile)}\ncat > /dev/null\nsleep 30`);
  const started = Date.now();
  // Not awaited yet: the grandchild's pid has to be observed while the run is
  // still alive, before the leash cuts it.
  const run = invokeAgent({
    ...unverified,
    provider: provider(cli),
    cwd: dir,
    prompt: "hang please",
    logPath: join(dir, "agent.log"),
    timeoutMs: 4_000,
    role: "worker",
  });

  let grandchild = 0;
  for (let i = 0; i < 70 && !grandchild; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      grandchild = Number(readFileSync(pidFile, "utf8").trim());
    } catch {
      /* not spawned yet */
    }
  }
  assert.ok(grandchild > 1, "fixture never reported a grandchild pid");
  assert.equal(processAlive(grandchild), true, "grandchild should be running before the timeout");

  const res = await run;

  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, null);
  assert.ok(res.signal === "SIGTERM" || res.signal === "SIGKILL", `unexpected signal ${res.signal}`);
  assert.ok(Date.now() - started < 20_000, "must not wait out the child's own sleep");

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(processAlive(grandchild), false, "grandchild survived the group kill");
});

test("grandchildren die even when the parent exits cleanly on the first SIGTERM", async () => {
  const dir = tmp("orphan");
  const pidFile = join(dir, "grandchild.pid");
  // The parent traps TERM and exits 7 immediately, leaving the grandchild to
  // keep the process group alive. Resolving on the parent's exit and stopping
  // there would leak it.
  const cli = fixtureCli(
    dir,
    "fake-claude",
    [
      "trap 'exit 7' TERM",
      "sleep 30 &",
      `echo $! > ${JSON.stringify(pidFile)}`,
      "cat > /dev/null",
      "sleep 30 &",
      "wait",
    ].join("\n"),
  );
  const run = invokeAgent({
    ...unverified,
    provider: provider(cli),
    cwd: dir,
    prompt: "hang",
    logPath: join(dir, "agent.log"),
    timeoutMs: 4_000,
    role: "worker",
  });

  let grandchild = 0;
  for (let i = 0; i < 70 && !grandchild; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      grandchild = Number(readFileSync(pidFile, "utf8").trim());
    } catch {
      /* not spawned yet */
    }
  }
  assert.ok(grandchild > 1, "fixture never reported a grandchild pid");

  const res = await run;
  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, 7, "the parent should have exited on its own TERM handler");

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(processAlive(grandchild), false, "grandchild outlived the run whose parent exited early");
});

test("the hard deadline includes the kill grace", async () => {
  const dir = tmp("deadline");
  // Ignores TERM entirely, so only the SIGKILL can end it.
  const cli = fixtureCli(dir, "fake-claude", "trap '' TERM\ncat > /dev/null\nsleep 30 &\nwait");
  const started = Date.now();
  const res = await invokeAgent({
    ...unverified,
    provider: provider(cli),
    cwd: dir,
    prompt: "ignore signals",
    logPath: join(dir, "agent.log"),
    timeoutMs: 3_000,
    role: "worker",
  });
  const elapsed = Date.now() - started;
  assert.equal(res.timedOut, true);
  assert.equal(res.signal, "SIGKILL", "a TERM-ignoring child must be killed");
  assert.ok(elapsed <= 3_000 + 1_500, `run ended ${elapsed}ms in, past its own 3000ms deadline`);
});

test("an onSpawn that throws kills the child instead of leaking it", async () => {
  const dir = tmp("onspawn");
  const cli = fixtureCli(dir, "fake-claude", "cat > /dev/null; sleep 30");
  let pid = 0;
  await assert.rejects(
    () =>
      invokeAgent({
        ...unverified,
        provider: provider(cli),
        cwd: dir,
        prompt: "x",
        logPath: join(dir, "agent.log"),
        timeoutMs: 20_000,
        role: "worker",
        onSpawn: (p) => {
          pid = p;
          throw new Error("state write failed");
        },
      }),
    /state write failed/,
  );
  assert.ok(pid > 1, "onSpawn should still have seen a pid");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(processAlive(pid), false, "the child outlived a failed onSpawn");
});

test("an abort signal terminates the run", async () => {
  const dir = tmp("abort");
  const cli = fixtureCli(dir, "fake-claude", "cat > /dev/null; sleep 30");
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 200);
  const res = await invokeAgent({
    ...unverified,
    provider: provider(cli),
    cwd: dir,
    prompt: "hang",
    logPath: join(dir, "agent.log"),
    timeoutMs: 30_000,
    role: "worker",
    signal: ctrl.signal,
  });
  assert.equal(res.aborted, true);
  assert.equal(res.timedOut, false);
  assert.ok(res.elapsedMs < 10_000);
});

test("output is bounded but both ends survive", async () => {
  const dir = tmp("bounded");
  // ~3MB of output with a distinctive first and last line.
  const cli = fixtureCli(
    dir,
    "fake-claude",
    `cat > /dev/null\necho FIRST_LINE_MARKER\nawk 'BEGIN{for(i=0;i<40000;i++) printf "%080d\\n", i}'\necho 'WAN_RESULT {"status":"complete"}'`,
  );
  const res = await invokeAgent({
    ...unverified,
    provider: provider(cli),
    cwd: dir,
    prompt: "flood",
    logPath: join(dir, "agent.log"),
    timeoutMs: 60_000,
    role: "worker",
  });
  assert.equal(res.truncated, true, "3MB should have been elided in the middle");
  assert.ok(res.text.length < 400_000, `kept ${res.text.length} bytes in memory`);
  assert.match(res.text, /FIRST_LINE_MARKER/, "head must be preserved");
  assert.deepEqual(parseAgentReport(res.text), { status: "complete" }, "tail must be preserved");
});

test("unsupported CLIs and roles fail with a reason, never a guessed flag", async () => {
  const dir = tmp("unsupported");
  await assert.rejects(
    () => invokeAgent({ ...unverified, provider: provider("/bin/true", "grok"), cwd: dir, prompt: "x", logPath: join(dir, "l"), timeoutMs: 1000, role: "worker" }),
    /unsupported CLI "grok".*refusing to guess flags/s,
  );
  await assert.rejects(
    () => invokeAgent({ ...unverified, provider: provider("/bin/true", "gemini"), cwd: dir, prompt: "x", logPath: join(dir, "l"), timeoutMs: 1000, role: "worker" }),
    /gemini cannot run role "worker".*yolo/s,
  );
  const opencode = fixtureCli(dir, 'opencode', 'cat > /dev/null; echo ok');
  const delegated = await invokeAgent({ ...unverified, provider: provider(opencode, 'opencode'), cwd: dir, prompt: 'x', logPath: join(dir, 'l'), timeoutMs: 10000, role: 'coordinator' });
  assert.equal(delegated.exitCode, 0, 'Provider-native permissions also apply to coordination');
  await assert.rejects(
    () => invokeAgent({ ...unverified, provider: provider("/bin/true", "claude"), cwd: dir, prompt: "x", logPath: join(dir, "l"), timeoutMs: 1000, role: "reviewer" }),
    /unknown role "reviewer"/,
  );
});

test("the timeout cap and soft checkpoint are the documented leash", () => {
  assert.equal(MAX_TIMEOUT_MS, 300_000);
  assert.equal(SOFT_CHECKPOINT_MS, 180_000);
  assert.ok(SOFT_CHECKPOINT_MS < MAX_TIMEOUT_MS);
});

test("child env drops nesting markers but keeps auth", () => {
  const env = childEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", MUSE_SESSION_ID: "s", TBH_SESSION_MESSAGE_SOCKET: "/x", ANTHROPIC_API_KEY: "secret", PATH: "/usr/bin" });
  assert.equal(env.MUSE_SESSION_ID, undefined);
  assert.equal(env.TBH_SESSION_MESSAGE_SOCKET, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, "secret", "existing CLI auth must survive");
  assert.equal(env.CI, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

// ---------------------------------------------------------------------------
// runCommand / process control
// ---------------------------------------------------------------------------

test("runCommand does not go through a shell", async () => {
  const injected = "$HOME && touch /tmp/wan-should-not-exist; echo pwned";
  const r = await runCommand("/bin/echo", [injected]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), injected, "argument was expanded by a shell");
});

test("runCommand reports a non-zero exit and stderr", async () => {
  const r = await runCommand("/bin/sh", ["-c", "echo boom >&2; exit 3"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /boom/);
});

test("process group and birth signature come from ps, not an imaginary Node API", async () => {
  assert.equal(typeof process.getpgid, "undefined", "Node grew a getpgid; the ps fallback can be revisited");
  const { spawn } = await import("node:child_process");
  const leader = spawn("/bin/sh", ["-c", "sleep 5"], { detached: true });
  const member = spawn("/bin/sh", ["-c", "sleep 5"], { detached: false });
  await new Promise((r) => setTimeout(r, 150));
  try {
    assert.equal(await processGroupId(leader.pid), leader.pid, "a detached child leads its own group");
    assert.equal(await processGroupId(member.pid), await processGroupId(process.pid), "an attached child shares our group");
    const sig = await processSignature(leader.pid);
    assert.match(sig, new RegExp(`^${leader.pid}:`));
    assert.equal(await processSignature(leader.pid), sig, "the signature must be stable while the process lives");
    assert.notEqual(await processSignature(member.pid), sig);
  } finally {
    leader.kill("SIGKILL");
    member.kill("SIGKILL");
  }
});

test("terminateOwnedProcess refuses pids it cannot claim", async () => {
  await assert.rejects(() => terminateOwnedProcess(1), /invalid or init/);
  await assert.rejects(() => terminateOwnedProcess(0), /invalid or init/);
  await assert.rejects(() => terminateOwnedProcess(-5), /invalid or init/);
  await assert.rejects(() => terminateOwnedProcess(1.5), /invalid or init/);
  await assert.rejects(() => terminateOwnedProcess(process.pid), /this process or its parent/);

  const { spawn } = await import("node:child_process");
  const stranger = spawn("/bin/sh", ["-c", "sleep 5"], { detached: false });
  await new Promise((r) => setTimeout(r, 150));
  try {
    // No recorded signature: we cannot prove the pid is still what we started.
    await assert.rejects(() => terminateOwnedProcess(stranger.pid), /no birth signature was recorded/);
    // With a *wrong* signature it is treated as a recycled pid, not ours.
    await assert.rejects(() => terminateOwnedProcess(stranger.pid, { signature: "999:not the same process" }), /birth signature changed/);
    // Even with the right signature, a process in our own group is not ours.
    const sig = await processSignature(stranger.pid);
    await assert.rejects(() => terminateOwnedProcess(stranger.pid, { signature: sig }), /not a process-group leader|shares this process's group/);
  } finally {
    stranger.kill("SIGKILL");
  }
});

test("terminateOwnedProcess kills a group leader whose signature still matches", async () => {
  const { spawn } = await import("node:child_process");
  const leader = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true });
  await new Promise((r) => setTimeout(r, 150));
  const signature = await processSignature(leader.pid);
  assert.ok(signature, "ps did not report the leader");
  await terminateOwnedProcess(leader.pid, { signature, graceMs: 1_000 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(processAlive(leader.pid), false);
});

test("processAlive is honest about live and dead pids", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn("/bin/sh", ["-c", "sleep 5"]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(processAlive(child.pid), true);
  child.kill("SIGKILL");
  await new Promise((r) => child.once("close", r));
  assert.equal(processAlive(child.pid), false);
  assert.equal(processAlive(0), false);
});

// ---------------------------------------------------------------------------
// selectProvider
// ---------------------------------------------------------------------------

const cand = (id, cli, tier, over = {}) => ({
  id, cli, label: id, command: cli, state: "ready", windows: [], tier, eligible: tier !== "exhausted", headroom: 70, ...over,
});
const decider = (ranked) => async () => ({ ranked });

test("selectProvider returns the top eligible supported provider", async () => {
  const sel = await selectProvider({ decider: decider([cand("claude", "claude", "plenty"), cand("codex", "codex", "ok")]) });
  assert.equal(sel.provider.cli, "claude");
  assert.match(sel.reason, /plenty/);
});

test("unsupported CLIs are skipped with a reason rather than invoked", async () => {
  const sel = await selectProvider({ decider: decider([cand("grok", "grok", "plenty"), cand("codex", "codex", "ok")]) });
  assert.equal(sel.provider.cli, "codex", "must fall through to a supported adapter");

  const none = await selectProvider({ decider: decider([cand("grok", "grok", "plenty"), cand("cursor-agent", "cursor-agent", "ok")]) });
  assert.equal(none.provider, undefined);
  assert.match(none.reason, /grok is not a supported adapter/);
});

test("role support filters the pool, including the read-only controller roles", async () => {
  const ranked = [cand("gemini", "gemini", "plenty"), cand("opencode", "opencode", "plenty"), cand("codex", "codex", "ok")];
  for (const role of ["planner", "coordinator", "verifier"]) {
    const sel = await selectProvider({ decider: decider(ranked), role });
    assert.equal(sel.provider.cli, "opencode", `${role} should use the eligible provider with its own policy`);
  }
  const worker = await selectProvider({ decider: decider(ranked), role: "worker" });
  assert.equal(worker.provider.cli, "opencode", "opencode is a supported worker");

  const onlyGemini = await selectProvider({ decider: decider([cand("gemini", "gemini", "plenty")]), role: "planner" });
  assert.equal(onlyGemini.provider, undefined);
  assert.match(onlyGemini.reason, /gemini cannot run role "planner"/);

  await assert.rejects(() => selectProvider({ decider: decider(ranked), role: "architect" }), /unknown role "architect"/);
});

test("diversity applies only among equally-strong candidates", async () => {
  const sameTier = [cand("claude", "claude", "plenty"), cand("codex", "codex", "plenty")];
  const rotated = await selectProvider({ decider: decider(sameTier), preferDifferentFrom: ["claude"] });
  assert.equal(rotated.provider.cli, "codex");
  assert.match(rotated.reason, /rotated off claude/);

  // Rotating onto a materially weaker agent is worse than repeating.
  const mixed = [cand("claude", "claude", "plenty"), cand("codex", "codex", "low", { headroom: 8 })];
  const kept = await selectProvider({ decider: decider(mixed), preferDifferentFrom: ["claude"] });
  assert.equal(kept.provider.cli, "claude");
  assert.match(kept.reason, /no equally-strong alternative/);
});

test("only and exclude narrow the pool", async () => {
  const ranked = [cand("claude", "claude", "plenty"), cand("codex", "codex", "plenty")];
  assert.equal((await selectProvider({ decider: decider(ranked), only: ["codex"] })).provider.cli, "codex");
  assert.equal((await selectProvider({ decider: decider(ranked), exclude: ["claude"] })).provider.cli, "codex");
});

// ---------------------------------------------------------------------------
// retry timing
// ---------------------------------------------------------------------------

const win = (label, usedPercent, inMinutes) => ({
  label,
  usedPercent,
  ...(inMinutes === undefined ? {} : { resetsAt: new Date(Date.now() + inMinutes * 60_000).toISOString() }),
});

test("a candidate is only free when its slowest blocking window resets", () => {
  const spent = cand("claude", "claude", "exhausted", {
    headroom: 0,
    eligible: false,
    windows: [win("5h", 100, 20), win("weekly", 100, 4_000)],
  });
  const at = nextRetryAt([spent], { minHeadroom: 5 });
  assert.equal(
    at,
    Date.parse(spent.windows[1].resetsAt),
    "the 5h reset is not a retry point while the weekly window is still spent",
  );
});

test("retry timing ignores windows that are not actually blocking", () => {
  const c = cand("claude", "claude", "exhausted", {
    headroom: 0,
    eligible: false,
    windows: [win("5h", 100, 90), win("weekly", 12, 10)],
  });
  assert.equal(nextRetryAt([c], { minHeadroom: 5 }), Date.parse(c.windows[0].resetsAt));
});

test("retry timing ignores unauthenticated and errored CLIs", () => {
  const rows = [
    cand("a", "claude", "exhausted", { state: "unauthenticated", eligible: false, headroom: undefined, windows: [win("5h", 100, 10)] }),
    cand("b", "codex", "exhausted", { state: "error", eligible: false, headroom: undefined, windows: [win("5h", 100, 20)] }),
    cand("c", "claude", "exhausted", { eligible: false, headroom: 0, windows: [win("5h", 100, 180)] }),
  ];
  assert.equal(nextRetryAt(rows, { minHeadroom: 5 }), Date.parse(rows[2].windows[0].resetsAt), "a login problem is not a quota deadline");
  assert.equal(nextRetryAt(rows.slice(0, 2), { minHeadroom: 5 }), undefined);
});

test("a blocking window with no known reset makes its candidate unpredictable, not urgent", () => {
  const rows = [
    cand("a", "claude", "exhausted", { eligible: false, headroom: 0, windows: [win("5h", 100)] }),
    cand("b", "codex", "exhausted", { eligible: false, headroom: 0, windows: [win("5h", 100, 120)] }),
  ];
  assert.equal(nextRetryAt(rows, { minHeadroom: 5 }), Date.parse(rows[1].windows[0].resetsAt));
  assert.equal(nextRetryAt([rows[0]], { minHeadroom: 5 }), undefined, "a window with no reset time must not become a deadline");
});

test("exhaustion reports the earliest reset among relevant candidates only", async () => {
  const soonButExcluded = cand("claude", "claude", "exhausted", { eligible: false, headroom: 0, windows: [win("5h", 100, 15)] });
  const relevant = cand("codex", "codex", "exhausted", { eligible: false, headroom: 0, windows: [win("5h", 100, 120)] });
  const unsupported = cand("grok", "grok", "exhausted", { eligible: false, headroom: 0, windows: [win("5h", 100, 5)] });

  const sel = await selectProvider({ decider: decider([soonButExcluded, relevant, unsupported]), exclude: ["claude"] });
  assert.equal(sel.provider, undefined);
  assert.equal(sel.retryAt, Date.parse(relevant.windows[0].resetsAt), "an excluded or unsupported CLI's reset is not our deadline");
  assert.match(sel.reason, /earliest relevant window reset/);

  // The role filter narrows it the same way: gemini can never be a planner.
  const geminiSoon = cand("gemini", "gemini", "exhausted", { eligible: false, headroom: 0, windows: [win("5h", 100, 5)] });
  const roleSel = await selectProvider({ decider: decider([geminiSoon, relevant]), role: "planner" });
  assert.equal(roleSel.retryAt, Date.parse(relevant.windows[0].resetsAt));
});

// ---------------------------------------------------------------------------
// ownership matching
// ---------------------------------------------------------------------------

test("pathAllowed honours files, directories and ** globs", () => {
  assert.equal(pathAllowed("src/loop/runtime.ts", ["src/loop/runtime.ts"]), true);
  assert.equal(pathAllowed("src/loop/runtime.ts", ["src/loop"]), true);
  assert.equal(pathAllowed("src/loop/runtime.ts", ["src/loop/"]), true);
  assert.equal(pathAllowed("src/loop/runtime.ts", ["src/**"]), true, "src/** must own the whole subtree");
  assert.equal(pathAllowed("src/loop/deep/nested/x.ts", ["src/loop/**"]), true);
  assert.equal(pathAllowed("src/a.ts", ["src/*.ts"]), true);
  assert.equal(pathAllowed("src/loop/a.ts", ["src/*.ts"]), false, "* must not cross a path separator");
  assert.equal(pathAllowed("src/loop/a.ts", ["src/**/*.ts"]), true);
  assert.equal(pathAllowed("a.ts", ["**/*.ts"]), true, "** matches zero segments");
  assert.equal(pathAllowed("src/loop-other.ts", ["src/loop"]), false, "sibling prefix must not match a directory");
  assert.equal(pathAllowed("src/loop-other.ts", ["src/loop*"]), true);
  assert.equal(pathAllowed("src/loop/runtime.ts", ["src/loop*"]), false, "a single * owns one segment, not a subtree");
  assert.equal(pathAllowed("package.json", ["src/loop"]), false);
  assert.equal(pathAllowed("src/loop/runtime.ts", []), false);
});

test("pathAllowed rejects traversal, absolute paths and controller metadata anywhere", () => {
  assert.equal(pathAllowed("../escape.ts", ["../"]), false);
  assert.equal(pathAllowed("src/../../escape.ts", ["src/**"]), false, "traversal in the middle must be caught");
  assert.equal(pathAllowed("src/loop/../../../etc/passwd", ["**"]), false);
  assert.equal(pathAllowed("/etc/passwd", ["/etc"]), false);
  assert.equal(pathAllowed("/etc/passwd", ["**"]), false);
  assert.equal(pathAllowed("C:/Windows/system32", ["**"]), false);
  assert.equal(pathAllowed("..\\escape.ts", ["**"]), false, "backslash traversal must normalise first");

  assert.equal(pathAllowed(".git/config", ["**"]), false);
  assert.equal(pathAllowed("src/.git/hooks/pre-commit", ["src/**"]), false, ".git nested anywhere is off limits");
  assert.equal(pathAllowed(".wan-state.json", ["**"]), false);
  assert.equal(pathAllowed("src/loop/.wan-notes.md", ["src/**"]), false, "controller metadata is never the agent's to write");
});

// ---------------------------------------------------------------------------
// artifact hashing
// ---------------------------------------------------------------------------

test("artifactRevision tracks content and ignores git/node_modules/.wan metadata", async () => {
  const dir = tmp("artifact");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  const first = await artifactRevision(dir);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);

  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "junk.js"), "x");
  writeFileSync(join(dir, ".wan-state.json"), '{"step":3}');
  assert.equal(await artifactRevision(dir), first, "metadata must not move the hash");

  writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
  assert.notEqual(await artifactRevision(dir), first, "content change must move the hash");
});

test("artifactRevision records symlinks without following them", async () => {
  const outside = tmp("outside");
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "v1");

  const dir = tmp("symlink");
  symlinkSync(secret, join(dir, "link.txt"));
  const before = await artifactRevision(dir);

  writeFileSync(secret, "v2-completely-different-content");
  assert.equal(await artifactRevision(dir), before, "hash followed the symlink off-tree");

  symlinkSync(join(outside, "other.txt"), join(dir, "link2.txt"));
  assert.notEqual(await artifactRevision(dir), before, "a new link target must move the hash");
});

// ---------------------------------------------------------------------------
// git: identity, snapshot, integration
// ---------------------------------------------------------------------------

function fakeGh(login) {
  return fixtureCli(tmp("gh"), "gh", `echo ${login}`);
}

/**
 * A fixture wrapper that points git at a bot config file. Proves the identity
 * plumbing is injected rather than environmental, and gives non-macOS hosts a
 * bot identity to test against.
 */
function fixtureTools(name, email, login = BOT_GH_LOGIN) {
  const dir = tmp("botcfg");
  const cfg = join(dir, "gitconfig");
  writeFileSync(cfg, `[user]\n\tname = ${name}\n\temail = ${email}\n`);
  const wrapper = fixtureCli(dir, "git-as-bot", `GIT_CONFIG_GLOBAL=${JSON.stringify(cfg)} exec git "$@"`);
  return { ...defaultGitTools(), gitBot: [wrapper], gh: [fakeGh(login)] };
}

/**
 * On macOS this is the *real* path: the host's `git dougbot` alias supplies
 * the identity and only gh is faked, because the developer's own gh login is
 * the personal one. Elsewhere there is no alias, so a fixture stands in.
 */
function botTools(login = BOT_GH_LOGIN) {
  if (process.platform === "darwin") return { ...defaultGitTools(), gh: [fakeGh(login)] };
  return fixtureTools(BOT_GIT_NAME, `${BOT_GIT_NAME}@users.noreply.github.com`, login);
}

/** A repo with no local identity at all: whatever `gitBot` says goes. */
async function repo(prefix) {
  const dir = tmp(prefix);
  await runCommand("git", ["init", "-q", "-b", "main", dir]);
  await runCommand("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "base.ts"), "export const base = true;\n");
  await runCommand("git", ["-C", dir, "add", "-A"]);
  await runCommand("git", ["-C", dir, "-c", "user.name=seed", "-c", "user.email=seed@example.com", "commit", "-q", "-m", "base"]);
  return dir;
}

test("the host's `git dougbot` alias is what supplies the bot identity on macOS", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS-only path");
  const tools = defaultGitTools();
  assert.deepEqual([...tools.gitBot], ["git", "dougbot"], "writes must route through the alias, not plain git");

  const dir = await repo("alias");
  const plain = await runCommand("git", ["-C", dir, "config", "--get", "user.name"]);
  const bot = await runCommand("git", ["dougbot", "-C", dir, "config", "--get", "user.name"], { cwd: dir });
  if (bot.code !== 0) return t.skip("no `git dougbot` alias configured on this host");
  assert.equal(bot.stdout.trim(), BOT_GIT_NAME, "the alias must resolve to the bot identity");
  assert.notEqual(plain.stdout.trim(), BOT_GIT_NAME, "plain git still resolves to the developer — hence the alias");

  const id = await verifyBotIdentity(dir, botTools());
  assert.equal(id.name, BOT_GIT_NAME);
  assert.match(id.email, /dougbot-agent@users\.noreply\.github\.com$/);
});

test("the bot name must match exactly — near misses are a human, not the bot", async () => {
  const dir = await repo("exact");
  for (const name of ["dougbot", "Dougbot", "DougBot Agent", "dougbot-agent-2", "Seth Webster", ""]) {
    const tools = fixtureTools(name, "269356667+dougbot-agent@users.noreply.github.com");
    await assert.rejects(() => verifyBotIdentity(dir, tools), /user\.name is/, `accepted name ${JSON.stringify(name)}`);
  }
  for (const email of ["dougbot@users.noreply.github.com", "seth@expo.io", "dougbot-agent@example.com", ""]) {
    const tools = fixtureTools(BOT_GIT_NAME, email);
    await assert.rejects(() => verifyBotIdentity(dir, tools), /user\.email is/, `accepted email ${JSON.stringify(email)}`);
  }
  // Both forms of the GitHub noreply address are the bot.
  for (const email of ["dougbot-agent@users.noreply.github.com", "269356667+dougbot-agent@users.noreply.github.com"]) {
    const id = await verifyBotIdentity(dir, fixtureTools(BOT_GIT_NAME, email));
    assert.equal(id.email, email);
  }
});

test("a gh login that is not the bot blocks every write", async () => {
  const dir = await repo("ghlogin");
  const wrong = fixtureTools(BOT_GIT_NAME, "dougbot-agent@users.noreply.github.com", "sethwebster");
  await assert.rejects(() => verifyBotIdentity(dir, wrong), /gh is authenticated as "sethwebster"/);
  await assert.rejects(() => snapshotWorkspace(dir, "nope", wrong), /refusing git write/);
  // Worktree creation is a write too, so it is gated the same way.
  await assert.rejects(() => createWorktree(dir, join(tmp("wt"), "w"), "seth/w", "HEAD", wrong), /refusing git write/);

  // There is no environment variable that lowers the bar.
  process.env.WAN_BOT_GH_LOGIN = "sethwebster";
  try {
    await assert.rejects(() => verifyBotIdentity(dir, wrong), /gh is authenticated as "sethwebster"/);
  } finally {
    delete process.env.WAN_BOT_GH_LOGIN;
  }
  assert.equal(BOT_GH_LOGIN, "dougbot-agent");
  assert.equal(BOT_GIT_NAME, "dougbot-agent");
});

test("snapshot commits real changes as the bot, skips .wan metadata, and never pushes", async () => {
  const dir = await repo("snapshot");
  const tools = botTools();
  const base = await gitRevision(dir, tools);
  assert.equal(await snapshotWorkspace(dir, "no-op", tools), base, "a clean tree must not produce an empty commit");

  writeFileSync(join(dir, "src", "new.ts"), "export const added = 1;\n");
  writeFileSync(join(dir, ".wan-state.json"), '{"step":1}');
  const rev = await snapshotWorkspace(dir, "agent work", tools);
  assert.notEqual(rev, base);

  const tracked = await runCommand("git", ["-C", dir, "show", "--name-only", "--format=", rev]);
  assert.match(tracked.stdout, /src\/new\.ts/);
  assert.doesNotMatch(tracked.stdout, /\.wan-state\.json/, ".wan metadata leaked into the commit");

  const author = await runCommand("git", ["-C", dir, "log", "-1", "--format=%an <%ae>"]);
  assert.match(author.stdout, /dougbot-agent/, "commit must not carry personal attribution");
  assert.doesNotMatch(author.stdout, /sethwebster@gmail\.com/);

  // The repo's own config was never rewritten to make the check pass.
  const local = await runCommand("git", ["-C", dir, "config", "--local", "--get", "user.name"]);
  assert.equal(local.stdout.trim(), "", "identity must come from the alias, not from configuring the repo");

  const reflog = await runCommand("git", ["-C", dir, "reflog", "show", "--all"]);
  assert.doesNotMatch(reflog.stdout, /origin\//, "snapshot must not touch a remote");
});

test("inspectChanges shows a bounded diff while changePatch keeps the whole thing", async () => {
  const dir = await repo("inspect");
  const tools = botTools();
  const base = await gitRevision(dir, tools);
  writeFileSync(join(dir, "src", "committed.ts"), "export const c = 1;\n");
  await snapshotWorkspace(dir, "committed work", tools);
  writeFileSync(join(dir, "src", "dirty.ts"), "export const d = 2;\n");

  const seen = await inspectChanges(dir, base, { tools });
  assert.deepEqual(seen.files, ["src/committed.ts", "src/dirty.ts"]);
  assert.match(seen.diff, /export const c = 1/);
  assert.match(seen.diff, /export const d = 2/, "untracked work must appear in the diff");
  assert.equal(seen.truncated, false);

  const small = await inspectChanges(dir, base, { tools, displayBytes: 40 });
  assert.equal(small.truncated, true);
  assert.match(small.diff, /diff truncated at 40 bytes for display/);
  assert.equal(small.patchBytes, seen.patchBytes);

  const full = await changePatch(dir, base, tools);
  assert.equal(full.patch.length, seen.patchBytes, "the applyable patch is never the truncated one");
  assert.match(full.patch, /export const d = 2/);
});

test("an oversized patch is refused outright rather than applied in part", async () => {
  const dir = await repo("huge");
  const tools = botTools();
  const base = await gitRevision(dir, tools);
  // One file just over the cap, so the patch cannot be a partial apply.
  writeFileSync(join(dir, "src", "huge.ts"), `${"// filler line to make a large diff\n".repeat(120_000)}`);
  await assert.rejects(() => changePatch(dir, base, tools), /over the \d+-byte limit/);
  await assert.rejects(() => integrateWorktree(dir, dir, base, ["src/**"], tools), /over the \d+-byte limit/);
  assert.ok(MAX_PATCH_BYTES >= 1_000_000);
});

test("integrateWorktree moves owned work, refuses everything else, and preserves the worker", async () => {
  const target = await repo("target");
  const tools = botTools();
  const base = await gitRevision(target, tools);
  const worker = join(tmp("wt"), "worker");
  await createWorktree(target, worker, "seth/worker", base, tools);

  writeFileSync(join(worker, "src", "owned.ts"), "export const owned = 1;\n");
  writeFileSync(join(worker, "package.json"), "{}\n");
  await snapshotWorkspace(worker, "worker output", tools);

  await assert.rejects(
    () => integrateWorktree(target, worker, base, ["src/owned.ts"], tools),
    /out-of-scope paths package\.json/,
    "must refuse work outside the declared ownership",
  );
  await assert.rejects(() => integrateWorktree(target, worker, base, [], tools), /empty ownership list/);
  assert.ok(
    (await inspectChanges(worker, base, { tools })).files.includes("package.json"),
    "a refused integration must leave the source worktree untouched",
  );

  // The identity is confirmed before anything touches the target's index, not
  // just before the commit — a half-applied patch under the wrong identity is
  // still the wrong identity's work sitting in the tree.
  const wrongGh = { ...tools, gh: [fakeGh("sethwebster")] };
  await assert.rejects(() => integrateWorktree(target, worker, base, ["src/**", "package.json"], wrongGh), /gh is authenticated as "sethwebster"/);
  const untouched = await runCommand("git", ["-C", target, "status", "--porcelain"]);
  assert.equal(untouched.stdout.trim(), "", "a failed identity check must leave the target's index and tree clean");

  const result = await integrateWorktree(target, worker, base, ["src/**", "package.json"], tools);
  assert.equal(result.integrated, true);
  assert.match(result.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(result.files, ["package.json", "src/owned.ts"]);
  assert.equal(readFileSync(join(target, "src", "owned.ts"), "utf8"), "export const owned = 1;\n");

  // The worker is still intact, commits and all — nothing is ever cleaned up.
  assert.equal(readFileSync(join(worker, "src", "owned.ts"), "utf8"), "export const owned = 1;\n");
  assert.ok((await inspectChanges(worker, base, { tools })).files.length > 0, "the worker worktree must survive a successful integration");

  // The same work cannot land twice: the target has now changed those files.
  await assert.rejects(() => integrateWorktree(target, worker, base, ["src/**", "package.json"], tools), /already changed/);
});

test('dirty input snapshot includes the brief and edits without changing the original index', async () => {
  const source = await repo('dirty-input');
  const tools = botTools(), base = await gitRevision(source, tools);
  const target = join(tmp('dirty-copy'), 'integration');
  await createWorktree(source, target, 'wan/input-snapshot', base, tools);
  writeFileSync(join(source, 'BRIEF.md'), 'Implement every requirement in this brief.\n');
  writeFileSync(join(source, 'src', 'base.ts'), 'export const base = 2;\n');
  const before = await runCommand('git', ['-C', source, 'status', '--porcelain']);
  const result = await integrateWorktree(target, source, base, ['**'], tools);
  assert.equal(result.integrated, true);
  assert.equal(readFileSync(join(target, 'BRIEF.md'), 'utf8'), 'Implement every requirement in this brief.\n');
  assert.equal(readFileSync(join(target, 'src', 'base.ts'), 'utf8'), 'export const base = 2;\n');
  assert.equal(await gitRevision(source, tools), base);
  assert.equal((await runCommand('git', ['-C', source, 'status', '--porcelain'])).stdout, before.stdout);
  assert.equal((await runCommand('git', ['-C', target, 'status', '--porcelain'])).stdout.trim(), '');
});

test("a target that moved on with disjoint earlier work still accepts this task", async () => {
  const target = await repo("disjoint");
  const tools = botTools();
  const base = await gitRevision(target, tools);

  // Task A already landed in the target, off the same base.
  writeFileSync(join(target, "src", "task-a.ts"), "export const a = 1;\n");
  await snapshotWorkspace(target, "task A", tools);

  // Task B was cut from the same base and touches nothing task A touched.
  const worker = join(tmp("wt"), "task-b");
  await createWorktree(target, worker, "seth/task-b", base, tools);
  writeFileSync(join(worker, "src", "task-b.ts"), "export const b = 2;\n");
  await snapshotWorkspace(worker, "task B", tools);

  const result = await integrateWorktree(target, worker, base, ["src/**"], tools);
  assert.equal(result.integrated, true, "a disjoint earlier change in the target must not block this one");
  assert.deepEqual(result.files, ["src/task-b.ts"]);
  assert.equal(readFileSync(join(target, "src", "task-a.ts"), "utf8"), "export const a = 1;\n", "earlier work must survive");
  assert.equal(readFileSync(join(target, "src", "task-b.ts"), "utf8"), "export const b = 2;\n");
});

test("an empty diff is a no-op result, not a failure to retry forever", async () => {
  const target = await repo("empty");
  const tools = botTools();
  const base = await gitRevision(target, tools);
  const worker = join(tmp("wt"), "idle");
  await createWorktree(target, worker, "seth/idle", base, tools);

  const result = await integrateWorktree(target, worker, base, ["src/**"], tools);
  assert.equal(result.integrated, false);
  assert.deepEqual(result.files, []);
  assert.equal(result.revision, base, "the target's current revision is the candidate to carry forward");
  assert.match(result.reason, /no changes/);

  // Idempotent: calling again reports the same thing rather than escalating.
  const again = await integrateWorktree(target, worker, base, ["src/**"], tools);
  assert.deepEqual(again, result);
});

// ---------------------------------------------------------------------------
// host helpers
// ---------------------------------------------------------------------------

test("launchd restarts on crash only and pins a PATH", () => {
  const def = serviceDefinition(
    { name: "loop", command: ["/usr/bin/node", "cli.js", '--flag="a&b<c>"'], cwd: "/tmp/repo", logPath: "/tmp/loop.log" },
    "darwin",
  );
  assert.match(def.path, /Library\/LaunchAgents\/com\.wan\.loop\.plist$/);
  assert.match(def.content, /<string>--flag=&quot;a&amp;b&lt;c&gt;&quot;<\/string>/);
  assert.doesNotMatch(def.content, /[^&](&(?!amp;|quot;|lt;|gt;|apos;))/, "unescaped ampersand in plist");

  // An unconditional KeepAlive relaunches a finished supervisor forever.
  assert.doesNotMatch(def.content, /<key>KeepAlive<\/key>\s*<true\/>/, "KeepAlive true would restart a terminal exit endlessly");
  assert.match(def.content, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>\s*<\/dict>/);

  assert.match(def.content, /<key>EnvironmentVariables<\/key>/);
  assert.match(def.content, /<key>PATH<\/key><string>[^<]+<\/string>/);
  assert.ok(def.content.includes(process.env.PATH.split(":")[0]), "the live PATH must be carried into the plist");
  assert.ok(def.install.some((c) => c.includes("launchctl bootstrap")));
  assert.ok(def.uninstall.some((c) => c.includes("launchctl bootout")));
  assert.ok(def.notes.some((n) => /exit 0/.test(n)), "the exit-0 contract must be stated");
  assert.ok(def.notes.some((n) => /login/i.test(n)), "the login-session limitation must be documented");
});

test("systemd uses its own quoting and specifier escaping, not shell quoting", () => {
  const def = serviceDefinition(
    {
      name: "loop",
      command: ["node", "cli.js", "--msg=hello world;rm -rf /", '--quote="x"', "--pct=100%done", "--back=a\\b"],
      cwd: "/tmp/repo",
      logPath: "/tmp/loop.log",
      env: { WAN_TAG: "50% off" },
    },
    "linux",
  );
  assert.match(def.path, /\.config\/systemd\/user\/wan-loop\.service$/);

  // systemd quoting is double-quote based; a POSIX single-quoted word would be
  // passed through to the program with the quotes still attached.
  assert.match(def.content, /ExecStart=node cli\.js "--msg=hello world;rm -rf \/"/);
  assert.doesNotMatch(def.content, /ExecStart=.*'--msg=/, "shell single-quoting is wrong for a unit file");
  assert.match(def.content, /"--quote=\\"x\\""/, "a double quote must be backslash-escaped");
  assert.match(def.content, /"--back=a\\\\b"/, "a backslash must be doubled");

  // A bare % is a systemd specifier; it has to be doubled to stay literal.
  assert.match(def.content, /--pct=100%%done/);
  assert.match(def.content, /Environment="WAN_TAG=50%% off"/);
  assert.doesNotMatch(def.content, /(^|[^%])%[a-zA-Z](?![a-zA-Z])/m, "a live specifier escaped into the unit");

  assert.match(def.content, /Restart=on-failure/);
  assert.doesNotMatch(def.content, /Restart=always/, "always would restart a deliberate terminal exit");
  assert.match(def.content, /Environment="?PATH=/);
  assert.deepEqual(def.install, ["systemctl --user daemon-reload", "systemctl --user enable --now wan-loop.service"]);
  assert.ok(def.notes.some((n) => /enable-linger/.test(n)), "the user-session limitation must be documented");
});

test("serviceDefinition rejects unsafe names, empty commands, newlines and unknown platforms", () => {
  const spec = { name: "loop", command: ["node"], cwd: "/tmp", logPath: "/tmp/l.log" };
  assert.throws(() => serviceDefinition({ ...spec, name: "loop; rm -rf /" }, "linux"), /unsafe service name/);
  assert.throws(() => serviceDefinition({ ...spec, command: [] }, "linux"), /command is empty/);
  assert.throws(() => serviceDefinition(spec, "win32"), /no service definition for platform "win32"/);
  assert.throws(() => serviceDefinition({ ...spec, command: ["node", "a\nExecStart=/bin/sh"] }, "linux"), /single line/);
  assert.throws(() => serviceDefinition({ ...spec, command: ["node", "a\n<string>x"] }, "darwin"), /single line/);
});

test("tmux helpers reject unsafe session names before shelling out", async () => {
  const { tmuxStart, tmuxAlive } = await import("../dist/loop/runtime.js");
  assert.equal(await tmuxAlive("bad name; rm -rf /"), false);
  await assert.rejects(
    () => tmuxStart({ name: "bad;name", cwd: tmpdir(), command: ["sleep", "1"], logPath: join(tmpdir(), "x.log") }),
    /unsafe tmux session name/,
  );
  await assert.rejects(
    () => tmuxStart({ name: "wan-ok", cwd: tmpdir(), command: [], logPath: join(tmpdir(), "x.log") }),
    /command is empty/,
  );
});
