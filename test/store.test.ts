import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { quoteFtsQuery, Store, type CommandInput } from "../src/store.js";

let store: Store;
let sessionId: string;

function insert(overrides: Partial<CommandInput> = {}): number {
  return store.insertCommand({
    sessionId,
    command: "echo hello",
    output: "hello\n",
    exitCode: 0,
    cwd: "/home/me/project",
    gitRoot: "/home/me/project",
    gitBranch: "main",
    gitCommit: "a".repeat(40),
    startedAt: Date.now(),
    endedAt: Date.now() + 10,
    redactions: 0,
    outputBytes: 6,
    truncated: false,
    ...overrides,
  });
}

beforeEach(() => {
  store = new Store(":memory:");
  sessionId = store.createSession({
    shell: "/bin/bash",
    hostname: "testhost",
    user: "tester",
    mode: "interactive",
  });
});

afterEach(() => {
  store.close();
});

describe("Store", () => {
  it("inserts and retrieves commands", () => {
    const id = insert({ command: "git status", output: "clean tree\n" });
    const cmd = store.getCommand(id);
    expect(cmd).not.toBeNull();
    expect(cmd!.command).toBe("git status");
    expect(cmd!.output).toBe("clean tree\n");
    expect(cmd!.exitCode).toBe(0);
    expect(cmd!.gitBranch).toBe("main");
    expect(cmd!.durationMs).toBe(10);
  });

  it("returns null for missing ids", () => {
    expect(store.getCommand(999)).toBeNull();
  });

  it("full-text searches command text", () => {
    insert({ command: "npm install express", output: "added 60 packages\n" });
    insert({ command: "cargo build", output: "Compiling...\n" });
    const hits = store.search({ query: "express" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.command).toBe("npm install express");
  });

  it("full-text searches output text and returns a snippet", () => {
    insert({
      command: "npm test",
      output: "line one\nError: ENOENT no such file or directory ./missing.txt\nline three\n",
      exitCode: 1,
    });
    insert({ command: "ls", output: "a b c\n" });
    const hits = store.search({ query: "ENOENT" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.command).toBe("npm test");
    expect(hits[0]!.snippet).toContain(">>ENOENT<<");
  });

  it("matches multi-word queries as AND", () => {
    insert({ command: "make build", output: "undefined reference to foo\n" });
    insert({ command: "make test", output: "reference manual printed\n" });
    const hits = store.search({ query: "undefined reference" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.command).toBe("make build");
  });

  it("survives queries containing FTS5 operator characters", () => {
    insert({ command: "npm i", output: "npm ERR! code E404\n", exitCode: 1 });
    // "!", "-" and unbalanced quotes are FTS5 syntax errors when raw.
    for (const q of ["ERR!", "npm ERR! E404", 'unbalanced "quote', "-leading"]) {
      expect(() => store.search({ query: q })).not.toThrow();
    }
    const hits = store.search({ query: "npm ERR! E404" });
    expect(hits).toHaveLength(1);
  });

  it("matches paths and filenames via the literal-phrase fallback", () => {
    insert({ command: "cat ./config/app.yaml", output: "ok" });
    expect(store.search({ query: "./config/app.yaml" })).toHaveLength(1);
    expect(store.search({ query: "config/app.yaml" })).toHaveLength(1);
    expect(store.search({ query: "app.yaml" })).toHaveLength(1);
  });

  it("matches inside hyphenated and underscored identifiers", () => {
    insert({
      command: "npm run build",
      output: "Error: ENOENT open '/app/node_modules/left-pad/index.js'\n",
      exitCode: 1,
    });
    expect(store.search({ query: "left-pad" })).toHaveLength(1);
    expect(store.search({ query: "node_modules" })).toHaveLength(1);
    expect(store.search({ query: "index.js" })).toHaveLength(1);
  });

  it("supports raw FTS5 syntax for power users", () => {
    insert({ command: "one", output: "alpha beta" });
    insert({ command: "two", output: "alpha gamma" });
    const hits = store.search({ query: "alpha AND gamma" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.command).toBe("two");
  });

  it("filters by cwd, cwd prefix, branch, exit code and failure", () => {
    insert({ command: "a", cwd: "/proj/api", gitBranch: "main", exitCode: 0, output: "target" });
    insert({ command: "b", cwd: "/proj/web", gitBranch: "dev", exitCode: 1, output: "target" });
    insert({ command: "c", cwd: "/other", gitBranch: "dev", exitCode: 2, output: "target" });

    expect(store.search({ query: "target", cwd: "/proj/api" })).toHaveLength(1);
    expect(store.search({ query: "target", cwdPrefix: "/proj" })).toHaveLength(2);
    expect(store.search({ query: "target", gitBranch: "dev" })).toHaveLength(2);
    expect(store.search({ query: "target", exitCode: 2 })).toHaveLength(1);
    expect(store.search({ query: "target", failedOnly: true })).toHaveLength(2);
  });

  it("filters by time window", () => {
    const t0 = Date.parse("2026-07-01T00:00:00Z");
    insert({ command: "old", startedAt: t0, endedAt: t0 + 5, output: "target" });
    insert({ command: "new", startedAt: t0 + 86_400_000, endedAt: t0 + 86_400_005, output: "target" });
    const hits = store.search({ query: "target", sinceMs: t0 + 1000 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.command).toBe("new");
    const until = store.search({ query: "target", untilMs: t0 + 1000 });
    expect(until).toHaveLength(1);
    expect(until[0]!.command).toBe("old");
  });

  it("ranks command-text matches above output matches", () => {
    insert({ command: "grep needle file.txt", output: "nothing here\n" });
    insert({ command: "cat file.txt", output: "a needle in the haystack\n" });
    const hits = store.search({ query: "needle" });
    expect(hits[0]!.command).toBe("grep needle file.txt");
  });

  it("lists recent commands newest first with filters", () => {
    const t = Date.now();
    insert({ command: "first", startedAt: t - 2000, endedAt: t - 1990 });
    insert({ command: "second", startedAt: t - 1000, endedAt: t - 990, exitCode: 1 });
    insert({ command: "third", startedAt: t, endedAt: t + 10 });
    const all = store.listCommands({ limit: 10 });
    expect(all.map((c) => c.command)).toEqual(["third", "second", "first"]);
    const failed = store.listCommands({ failedOnly: true });
    expect(failed.map((c) => c.command)).toEqual(["second"]);
    expect(store.listCommands({ limit: 1 })).toHaveLength(1);
  });

  it("tracks sessions with command counts", () => {
    insert();
    insert();
    const other = store.createSession({
      shell: "/bin/zsh",
      hostname: "h",
      user: "u",
      mode: "exec",
    });
    insert({ sessionId: other });
    store.endSession(other);
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
    const bySession = Object.fromEntries(sessions.map((s) => [s.id, s]));
    expect(bySession[sessionId]!.commandCount).toBe(2);
    expect(bySession[other]!.commandCount).toBe(1);
    expect(bySession[other]!.endedAt).not.toBeNull();
  });

  it("prunes old commands and removes them from the FTS index", () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    insert({ command: "ancient-cmd", startedAt: t0, endedAt: t0 + 1, output: "ancient-output" });
    insert({ command: "recent-cmd", output: "recent-output" });
    const deleted = store.prune(t0 + 10_000);
    expect(deleted).toBe(1);
    expect(store.search({ query: "ancient-output" })).toHaveLength(0);
    expect(store.search({ query: "recent-output" })).toHaveLength(1);
    expect(store.countCommands()).toBe(1);
  });

  it("computes stats", () => {
    insert({ exitCode: 0, redactions: 2, cwd: "/a" });
    insert({ exitCode: 1, redactions: 1, cwd: "/a" });
    insert({ exitCode: null, cwd: "/b" });
    const s = store.stats();
    expect(s.commands).toBe(3);
    expect(s.failedCommands).toBe(1);
    expect(s.totalRedactions).toBe(3);
    expect(s.sessions).toBe(1);
    expect(s.topCwds[0]).toEqual({ cwd: "/a", count: 2 });
  });

  it("search results omit the full output field (fetch via getCommand)", () => {
    insert({ output: "sensitive-full-output searchable-token" });
    const hits = store.search({ query: "searchable-token" });
    expect(hits[0]).not.toHaveProperty("output");
  });
});

describe("quoteFtsQuery", () => {
  it("quotes every token", () => {
    expect(quoteFtsQuery("npm ERR! E404")).toBe('"npm" "ERR!" "E404"');
  });
  it("escapes embedded double quotes", () => {
    expect(quoteFtsQuery('say "hi"')).toBe('"say" """hi"""');
  });
});
