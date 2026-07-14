import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMcpServer } from "../src/mcp.js";
import { Store } from "../src/store.js";

let store: Store;
let client: Client;

function seed() {
  const session = store.createSession({
    shell: "/bin/bash",
    hostname: "devbox",
    user: "alice",
    mode: "interactive",
  });
  const t = Date.parse("2026-07-07T15:00:00Z");
  store.insertCommand({
    sessionId: session,
    command: "npm test",
    output:
      "FAIL src/db.test.ts\n  ● connects to db\n    Error: ECONNREFUSED 127.0.0.1:5432 (is postgres running?)\n",
    exitCode: 1,
    cwd: "/home/alice/webapp",
    gitRoot: "/home/alice/webapp",
    gitBranch: "feature/login",
    gitCommit: "b".repeat(40),
    startedAt: t,
    endedAt: t + 4200,
    redactions: 0,
    outputBytes: 90,
    truncated: false,
  });
  store.insertCommand({
    sessionId: session,
    command: "docker compose up -d postgres",
    output: "Container postgres Started\n",
    exitCode: 0,
    cwd: "/home/alice/webapp",
    gitRoot: "/home/alice/webapp",
    gitBranch: "feature/login",
    gitCommit: "b".repeat(40),
    startedAt: t + 60_000,
    endedAt: t + 62_000,
    redactions: 0,
    outputBytes: 28,
    truncated: false,
  });
  store.endSession(session);
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  expect(content[0]?.type).toBe("text");
  return content[0]!.text!;
}

beforeEach(async () => {
  store = new Store(":memory:");
  seed();
  const server = createMcpServer(store, "0.0.0-test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  store.close();
});

describe("termtape MCP server", () => {
  it("advertises the four history tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_command_output",
      "list_recent_commands",
      "list_sessions",
      "search_terminal_history",
    ]);
    const search = tools.find((t) => t.name === "search_terminal_history")!;
    expect(search.description).toContain("terminal");
    expect(search.inputSchema).toMatchObject({ type: "object" });
  });

  it("answers 'what was that error yesterday' via search_terminal_history", async () => {
    const result = await client.callTool({
      name: "search_terminal_history",
      arguments: { query: "ECONNREFUSED postgres" },
    });
    const payload = JSON.parse(firstText(result));
    expect(payload.total_returned).toBe(1);
    expect(payload.results[0].command).toBe("npm test");
    expect(payload.results[0].exit_code).toBe(1);
    expect(payload.results[0].cwd).toBe("/home/alice/webapp");
    expect(payload.results[0].git_branch).toBe("feature/login");
    expect(payload.results[0].output_snippet).toContain("ECONNREFUSED");
  });

  it("supports failed_only and cwd filters", async () => {
    const result = await client.callTool({
      name: "search_terminal_history",
      arguments: { query: "postgres", failed_only: true },
    });
    const payload = JSON.parse(firstText(result));
    expect(payload.total_returned).toBe(1);
    expect(payload.results[0].command).toBe("npm test");
  });

  it("returns full output through get_command_output", async () => {
    const search = await client.callTool({
      name: "search_terminal_history",
      arguments: { query: "ECONNREFUSED" },
    });
    const id = JSON.parse(firstText(search)).results[0].id as number;
    const result = await client.callTool({
      name: "get_command_output",
      arguments: { id },
    });
    const payload = JSON.parse(firstText(result));
    expect(payload.command).toBe("npm test");
    expect(payload.output).toContain("Error: ECONNREFUSED 127.0.0.1:5432");
    expect(payload.started_at).toBe("2026-07-07T15:00:00.000Z");
    expect(payload.duration_ms).toBe(4200);
  });

  it("clips very long output but keeps head and tail", async () => {
    const session = store.createSession({
      shell: "x",
      hostname: "h",
      user: "u",
      mode: "exec",
    });
    const id = store.insertCommand({
      sessionId: session,
      command: "big",
      output: "START-" + "x".repeat(100_000) + "-END",
      exitCode: 0,
      cwd: "/",
      gitRoot: null,
      gitBranch: null,
      gitCommit: null,
      startedAt: Date.now(),
      endedAt: Date.now(),
      redactions: 0,
      outputBytes: 100_010,
      truncated: false,
    });
    const result = await client.callTool({
      name: "get_command_output",
      arguments: { id, max_chars: 1000 },
    });
    const payload = JSON.parse(firstText(result));
    expect(payload.output_clipped_for_response).toBe(true);
    expect(payload.output).toContain("START-");
    expect(payload.output).toContain("-END");
    expect(payload.output.length).toBeLessThan(1300);
  });

  it("returns an error result for unknown ids", async () => {
    const result = await client.callTool({
      name: "get_command_output",
      arguments: { id: 424242 },
    });
    expect(result.isError).toBe(true);
  });

  it("returns an error result for unparseable since", async () => {
    const result = await client.callTool({
      name: "search_terminal_history",
      arguments: { query: "x", since: "the other day" },
    });
    expect(result.isError).toBe(true);
  });

  it("lists recent commands newest first", async () => {
    const result = await client.callTool({
      name: "list_recent_commands",
      arguments: { limit: 5 },
    });
    const payload = JSON.parse(firstText(result));
    expect(payload.results.map((r: { command: string }) => r.command)).toEqual([
      "docker compose up -d postgres",
      "npm test",
    ]);
  });

  it("lists sessions", async () => {
    const result = await client.callTool({ name: "list_sessions", arguments: {} });
    const payload = JSON.parse(firstText(result));
    expect(payload.total_returned).toBe(1);
    expect(payload.results[0].shell).toBe("/bin/bash");
    expect(payload.results[0].commands).toBe(2);
    expect(payload.results[0].ended_at).not.toBeNull();
  });
});
