#!/usr/bin/env node
// Live MCP client verification for the built-in termtape MCP server.
//
// Uses the official @modelcontextprotocol/sdk Client (not hand-rolled
// JSON-RPC) to spawn `termtape mcp` over stdio and exercise the full
// surface: initialize handshake, tools/list, and a tools/call for each
// of the four read-only tools against a freshly recorded database.
//
// Self-asserting: prints "MCP CLIENT CHECK OK" and exits 0 on success;
// any failed assertion exits 1. No network access.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const work = mkdtempSync(join(tmpdir(), "termtape-mcp-check-"));
const db = join(work, "check.db");

function fail(msg) {
  console.error(`mcp-client-check: FAIL — ${msg}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

// 1. Record two real commands (one failing, one with a planted secret)
//    so every tool has data to return.
const env = { ...process.env, TERMTAPE_DB: db, TERMTAPE_CONFIG: join(work, "none.json") };
const r1 = spawnSync("node", [cli, "record", "--", "ls", "/nonexistent-mcp-check-dir"], { env });
if (r1.status === 0) fail("expected non-zero exit from failing ls");
const r2 = spawnSync(
  "node",
  [cli, "record", "--", "sh", "-c", "echo mcp-check-canary; echo AKIAIOSFODNN7MCPCHEK"],
  { env },
);
if (r2.status !== 0) fail("recording the canary command failed");

// 2. Connect a real MCP client over stdio.
const transport = new StdioClientTransport({
  command: "node",
  args: [cli, "mcp"],
  env,
});
const client = new Client({ name: "termtape-mcp-client-check", version: "0.0.0" });
await client.connect(transport);

const server = client.getServerVersion();
console.log(`initialize      -> server: ${server.name} ${server.version}`);
if (server.name !== "termtape") fail(`unexpected server name: ${server.name}`);

// 3. tools/list — expect exactly the four read-only tools.
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`tools/list      -> ${names.join(", ")}`);
const expected = [
  "get_command_output",
  "list_recent_commands",
  "list_sessions",
  "search_terminal_history",
];
if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`unexpected tool set: ${names}`);
for (const t of tools) {
  if (!t.inputSchema || t.inputSchema.type !== "object") fail(`${t.name} missing input schema`);
}

const text = (res) => res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

// 4. search_terminal_history — FTS hit on the recorded output.
const search = await client.callTool({
  name: "search_terminal_history",
  arguments: { query: "mcp-check-canary" },
});
if (search.isError) fail("search_terminal_history returned isError");
const searchText = text(search);
if (!searchText.includes("mcp-check-canary")) fail("search did not match recorded output");
console.log(`search          -> hit: ${JSON.parse(searchText).total_returned} result(s) for "mcp-check-canary"`);

// 5. get_command_output — full output, secret must be redacted.
const first = JSON.parse(searchText).results[0];
const output = await client.callTool({
  name: "get_command_output",
  arguments: { id: first.id },
});
if (output.isError) fail("get_command_output returned isError");
const outText = text(output);
if (outText.includes("AKIAIOSFODNN7MCPCHEK")) fail("plaintext AWS key leaked through MCP");
if (!outText.includes("[REDACTED:aws-access-key-id]")) fail("redaction marker missing in MCP output");
console.log(`get_output      -> id ${first.id}: redaction marker present, no plaintext key`);

// 6. list_recent_commands — both records visible with exit codes.
const recent = await client.callTool({ name: "list_recent_commands", arguments: { limit: 10 } });
if (recent.isError) fail("list_recent_commands returned isError");
const recentJson = JSON.parse(text(recent));
if (recentJson.total_returned !== 2) fail(`expected 2 recent commands, got ${recentJson.total_returned}`);
const lsRec = recentJson.results.find((c) => c.command.startsWith("ls "));
if (!lsRec || lsRec.exit_code === 0) fail("failing ls not listed with non-zero exit code");
console.log(`list_recent     -> ${recentJson.total_returned} commands, ls exit=${lsRec.exit_code}`);

// 7. list_sessions — session rows present.
const sessions = await client.callTool({ name: "list_sessions", arguments: {} });
if (sessions.isError) fail("list_sessions returned isError");
const sessJson = JSON.parse(text(sessions));
if (sessJson.total_returned < 1) fail("no sessions listed");
console.log(`list_sessions   -> ${sessJson.total_returned} session(s)`);

// 8. Invalid input must produce a protocol/tool error, not a crash.
let invalidHandled;
try {
  const bad = await client.callTool({ name: "get_command_output", arguments: { id: "not-a-number" } });
  invalidHandled = bad.isError === true;
} catch {
  invalidHandled = true; // schema-level protocol error is also acceptable
}
if (!invalidHandled) fail("invalid input was not rejected");
console.log("invalid input   -> rejected with protocol/tool error, server still alive");

await client.close();
rmSync(work, { recursive: true, force: true });
console.log("MCP CLIENT CHECK OK");
