import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Start the server; `call` sends one request and resolves with its response. */
function server() {
  const child = spawn(process.execPath, ["dist/mcp.js"], { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let next = 1;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return { call, close: () => child.stdin.end() };
}

test("mcp: handshake negotiates a protocol version and advertises tools", async () => {
  const s = server();
  const init = await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, "which-agent-next");

  const fallback = await s.call("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(fallback.result.protocolVersion, "2025-11-25");

  const { result } = await s.call("tools/list");
  assert.deepEqual(result.tools.map((t) => t.name), ["pick_agent", "list_agents"]);
  s.close();
});

test("mcp: bad input is a tool error, unknown names are protocol errors", async () => {
  const s = server();
  const bad = await s.call("tools/call", { name: "pick_agent", arguments: { only: ["nope"] } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /only matched no known CLI/);

  const wrongType = await s.call("tools/call", { name: "list_agents", arguments: { exclude: "codex" } });
  assert.equal(wrongType.result.isError, true);

  const unknownTool = await s.call("tools/call", { name: "nope", arguments: {} });
  assert.equal(unknownTool.error.code, -32602);

  const unknownMethod = await s.call("resources/list");
  assert.equal(unknownMethod.error.code, -32601);
  s.close();
});
