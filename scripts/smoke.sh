#!/usr/bin/env bash
# termtape smoke test: exercises the CLI end-to-end (record -> search ->
# show -> redact) and performs a full MCP protocol round-trip
# (initialize -> tools/list -> tools/call) over stdio.
#
# Self-asserting, idempotent, no network access. Prints "SMOKE OK" and
# exits 0 on success; any failure exits non-zero.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli.js"

if [ ! -f "$CLI" ]; then
  echo "smoke: dist/cli.js not found — building..." >&2
  (cd "$ROOT" && npm run build >/dev/null)
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TERMTAPE_DB="$WORK/smoke.db"
export TERMTAPE_CONFIG="$WORK/no-config.json"

fail() {
  echo "smoke: FAIL — $1" >&2
  exit 1
}

echo "[smoke] 1/7 --version and --help"
ver="$(node "$CLI" --version)"
[ "$ver" = "0.1.0" ] || fail "unexpected --version output: $ver"
node "$CLI" --help | grep -q "flight recorder" || fail "--help missing description"

echo "[smoke] 2/7 record a real command (exec mode) with a planted secret"
out="$(node "$CLI" record -- sh -c 'echo smoke-canary-output; echo "export API_TOKEN=hunter2secret99"; exit 3' 2>&1)" && fail "exit code 3 not propagated"
echo "$out" | grep -q "smoke-canary-output" || fail "command output not passed through"

echo "[smoke] 3/7 search finds the command via its output"
node "$CLI" search smoke-canary-output | grep -q "sh -c" || fail "FTS search did not find the recorded command"

echo "[smoke] 4/7 exit code and failure filter recorded"
node "$CLI" list --failed | grep -q "\[3\]" || fail "non-zero exit code not recorded"

echo "[smoke] 5/7 secret was redacted before storage (command, output and session argv)"
show="$(node "$CLI" show 1)"
echo "$show" | grep -q "hunter2secret99" && fail "secret leaked into storage"
echo "$show" | grep -q "\[REDACTED:generic-assignment\]" || fail "redaction marker missing"
sess="$(node "$CLI" sessions)"
echo "$sess" | grep -q "hunter2secret99" && fail "secret leaked into session record (exec argv)"
echo "$sess" | grep -q "\[REDACTED:generic-assignment\]" || fail "session argv redaction marker missing"
node "$CLI" sessions --json | grep -q "hunter2secret99" && fail "secret leaked into sessions --json"

echo "[smoke] 6/7 stats reports the recording"
node "$CLI" stats | grep -q "commands    1" || fail "stats does not show 1 command"

echo "[smoke] 7/7 MCP protocol round-trip (initialize -> tools/list -> tools/call)"
node --input-type=module - "$CLI" <<'EOF'
import { spawn } from "node:child_process";

const cli = process.argv[2];
const child = spawn("node", [cli, "mcp"], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
  }
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const request = (id, method, params) =>
  new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    send({ jsonrpc: "2.0", id, method, params });
  });

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`smoke: FAIL — MCP: ${msg}`);
    child.kill();
    process.exit(1);
  }
};

const init = await request(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
assert(init.result?.serverInfo?.name === "termtape", "initialize: bad serverInfo");
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const list = await request(2, "tools/list", {});
const names = list.result.tools.map((t) => t.name).sort();
assert(
  JSON.stringify(names) ===
    JSON.stringify([
      "get_command_output",
      "list_recent_commands",
      "list_sessions",
      "search_terminal_history",
    ]),
  `tools/list: unexpected tools ${names}`,
);
for (const t of list.result.tools) {
  assert(t.inputSchema?.type === "object", `tool ${t.name} missing JSON Schema`);
}

const call = await request(3, "tools/call", {
  name: "search_terminal_history",
  arguments: { query: "smoke-canary-output" },
});
const payload = JSON.parse(call.result.content[0].text);
assert(payload.total_returned === 1, "tools/call: search found nothing");
assert(payload.results[0].exit_code === 3, "tools/call: wrong exit code");

const full = await request(4, "tools/call", {
  name: "get_command_output",
  arguments: { id: payload.results[0].id },
});
const record = JSON.parse(full.result.content[0].text);
assert(record.output.includes("smoke-canary-output"), "get_command_output: output missing");
assert(!record.output.includes("hunter2secret99"), "get_command_output: secret leaked");

const sessions = await request(5, "tools/call", {
  name: "list_sessions",
  arguments: {},
});
const sessText = sessions.result.content[0].text;
assert(!sessText.includes("hunter2secret99"), "list_sessions: exec argv secret leaked");
assert(sessText.includes("[REDACTED:generic-assignment]"), "list_sessions: argv not redacted");

const bad = await request(6, "tools/call", {
  name: "search_terminal_history",
  arguments: { limit: "not-a-number" },
});
assert(
  bad.error !== undefined || bad.result?.isError === true,
  "invalid input did not produce an error response",
);

child.kill();
console.log("[smoke] MCP round-trip OK (4 tools, schema-validated, redacted)");
EOF

echo "SMOKE OK"
