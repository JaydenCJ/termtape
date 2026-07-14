/**
 * SQLite storage with FTS5 full-text search.
 *
 * Built on node:sqlite (bundled with Node >= 22.13, FTS5 enabled) — zero
 * native npm dependencies for the storage layer.
 *
 * Schema:
 *   sessions        one row per `termtape record` invocation
 *   commands        one row per executed command (output already redacted)
 *   commands_fts    external-content FTS5 index over command/output/cwd/branch,
 *                   kept in sync by triggers
 *
 * The database file is created 0600 inside a 0700 directory: the recording
 * is private to the user by default.
 */

import "./quiet.js";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";

// node:sqlite emits its ExperimentalWarning when the module is *linked*,
// which for a static ESM import happens before any user code (including
// quiet.js) runs. Loading it lazily through createRequire defers that to
// evaluation time, after the suppression in quiet.js is installed.
const requireBuiltin = createRequire(import.meta.url);
const { DatabaseSync: SqliteDatabase } = requireBuiltin(
  "node:sqlite",
) as typeof import("node:sqlite");

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number | null;
  shell: string;
  hostname: string;
  user: string;
  mode: "interactive" | "exec";
  commandCount?: number;
}

export interface CommandInput {
  sessionId: string;
  command: string;
  output: string;
  exitCode: number | null;
  cwd: string;
  gitRoot: string | null;
  gitBranch: string | null;
  gitCommit: string | null;
  startedAt: number;
  endedAt: number | null;
  redactions: number;
  outputBytes: number;
  truncated: boolean;
}

export interface CommandRecord extends CommandInput {
  id: number;
  durationMs: number | null;
}

export interface SearchHit extends Omit<CommandRecord, "output"> {
  /** FTS5 snippet from the matched column (output weighted). */
  snippet: string;
  /** bm25 rank — lower is a better match. */
  rank: number;
}

export interface SearchOptions {
  query: string;
  cwd?: string;
  cwdPrefix?: string;
  gitBranch?: string;
  exitCode?: number;
  failedOnly?: boolean;
  sinceMs?: number;
  untilMs?: number;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export interface ListOptions {
  cwd?: string;
  cwdPrefix?: string;
  failedOnly?: boolean;
  sessionId?: string;
  sinceMs?: number;
  limit?: number;
  offset?: number;
}

export interface StoreStats {
  dbPath: string;
  dbSizeBytes: number | null;
  sessions: number;
  commands: number;
  failedCommands: number;
  totalRedactions: number;
  firstCommandAt: number | null;
  lastCommandAt: number | null;
  topCwds: { cwd: string; count: number }[];
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  shell TEXT NOT NULL,
  hostname TEXT NOT NULL,
  user TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'interactive'
);

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  command TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  cwd TEXT NOT NULL DEFAULT '',
  git_root TEXT,
  git_branch TEXT,
  git_commit TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  redactions INTEGER NOT NULL DEFAULT 0,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_commands_started_at ON commands(started_at);
CREATE INDEX IF NOT EXISTS idx_commands_session ON commands(session_id);
CREATE INDEX IF NOT EXISTS idx_commands_cwd ON commands(cwd);

-- Default unicode61 tokenizer: '-', '_', '.', '/' are separators, so a query
-- like "config.json" or "node_modules" (quoted into a phrase by the literal
-- fallback) still matches inside paths and hyphenated identifiers.
CREATE VIRTUAL TABLE IF NOT EXISTS commands_fts USING fts5(
  command, output, cwd, git_branch,
  content='commands',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS commands_ai AFTER INSERT ON commands BEGIN
  INSERT INTO commands_fts(rowid, command, output, cwd, git_branch)
  VALUES (new.id, new.command, new.output, new.cwd, new.git_branch);
END;

CREATE TRIGGER IF NOT EXISTS commands_ad AFTER DELETE ON commands BEGIN
  INSERT INTO commands_fts(commands_fts, rowid, command, output, cwd, git_branch)
  VALUES ('delete', old.id, old.command, old.output, old.cwd, old.git_branch);
END;
`;

function rowToCommand(row: Record<string, unknown>): CommandRecord {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    command: String(row.command),
    output: String(row.output ?? ""),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    cwd: String(row.cwd ?? ""),
    gitRoot: row.git_root === null ? null : String(row.git_root),
    gitBranch: row.git_branch === null ? null : String(row.git_branch),
    gitCommit: row.git_commit === null ? null : String(row.git_commit),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    redactions: Number(row.redactions ?? 0),
    outputBytes: Number(row.output_bytes ?? 0),
    truncated: Number(row.truncated ?? 0) === 1,
  };
}

/**
 * Turn free text into a safe FTS5 MATCH expression: every whitespace token is
 * double-quoted so FTS5 operator characters ('-', '.', '"', 'NEAR', ...)
 * are treated literally.
 */
export function quoteFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(" ");
}

export class Store {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.db = new SqliteDatabase(dbPath);
    if (dbPath !== ":memory:") {
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {
        // best effort (e.g. exotic filesystems)
      }
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    const ver = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!ver) {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- sessions

  createSession(input: {
    shell: string;
    hostname: string;
    user: string;
    mode: "interactive" | "exec";
    startedAt?: number;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO sessions (id, started_at, shell, hostname, user, mode) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.startedAt ?? Date.now(), input.shell, input.hostname, input.user, input.mode);
    return id;
  }

  endSession(id: string, endedAt: number = Date.now()): void {
    this.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(endedAt, id);
  }

  listSessions(limit = 20): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM commands c WHERE c.session_id = s.id) AS command_count
         FROM sessions s ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      startedAt: Number(r.started_at),
      endedAt: r.ended_at === null ? null : Number(r.ended_at),
      shell: String(r.shell),
      hostname: String(r.hostname),
      user: String(r.user),
      mode: (String(r.mode) as "interactive" | "exec") ?? "interactive",
      commandCount: Number(r.command_count ?? 0),
    }));
  }

  // ---------------------------------------------------------------- commands

  insertCommand(input: CommandInput): number {
    const durationMs =
      input.endedAt !== null && input.endedAt >= input.startedAt
        ? input.endedAt - input.startedAt
        : null;
    const res = this.db
      .prepare(
        `INSERT INTO commands
           (session_id, command, output, exit_code, cwd, git_root, git_branch, git_commit,
            started_at, ended_at, duration_ms, redactions, output_bytes, truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.command,
        input.output,
        input.exitCode,
        input.cwd,
        input.gitRoot,
        input.gitBranch,
        input.gitCommit,
        input.startedAt,
        input.endedAt,
        durationMs,
        input.redactions,
        input.outputBytes,
        input.truncated ? 1 : 0,
      );
    return Number(res.lastInsertRowid);
  }

  getCommand(id: number): CommandRecord | null {
    const row = this.db.prepare("SELECT * FROM commands WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToCommand(row) : null;
  }

  listCommands(options: ListOptions = {}): CommandRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    this.applyCommonFilters(where, params, options);
    const sql = `SELECT * FROM commands ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY started_at DESC LIMIT ? OFFSET ?`;
    params.push(options.limit ?? 20, options.offset ?? 0);
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToCommand);
  }

  search(options: SearchOptions): SearchHit[] {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const where: string[] = [];
    const params: (string | number)[] = [];
    this.applyCommonFilters(where, params, options, "c.");

    const run = (match: string): SearchHit[] => {
      const sql = `
        SELECT c.id, c.session_id, c.command, c.exit_code, c.cwd, c.git_root, c.git_branch,
               c.git_commit, c.started_at, c.ended_at, c.duration_ms, c.redactions,
               c.output_bytes, c.truncated,
               snippet(commands_fts, 1, '>>', '<<', ' … ', 16) AS snip,
               bm25(commands_fts, 5.0, 1.0, 2.0, 2.0) AS rank
        FROM commands_fts
        JOIN commands c ON c.id = commands_fts.rowid
        WHERE commands_fts MATCH ?
          ${where.length ? "AND " + where.join(" AND ") : ""}
        ORDER BY rank
        LIMIT ? OFFSET ?`;
      const rows = this.db
        .prepare(sql)
        .all(match, ...params, limit, offset) as Record<string, unknown>[];
      return rows.map((r) => {
        const base = rowToCommand({ ...r, output: "" });
        const { output: _omit, ...rest } = base;
        return {
          ...rest,
          snippet: String(r.snip ?? ""),
          rank: Number(r.rank ?? 0),
        };
      });
    };

    // First try the query as raw FTS5 syntax (power users get AND/OR/NEAR/"");
    // if FTS rejects it, fall back to fully-quoted literal tokens.
    try {
      return run(options.query);
    } catch {
      return run(quoteFtsQuery(options.query));
    }
  }

  private applyCommonFilters(
    where: string[],
    params: (string | number)[],
    o: {
      cwd?: string;
      cwdPrefix?: string;
      gitBranch?: string;
      exitCode?: number;
      failedOnly?: boolean;
      sinceMs?: number;
      untilMs?: number;
      sessionId?: string;
    },
    prefix = "",
  ): void {
    if (o.cwd !== undefined) {
      where.push(`${prefix}cwd = ?`);
      params.push(o.cwd);
    }
    if (o.cwdPrefix !== undefined) {
      where.push(`${prefix}cwd GLOB ?`);
      params.push(o.cwdPrefix.replaceAll("[", "[[]") + "*");
    }
    if (o.gitBranch !== undefined) {
      where.push(`${prefix}git_branch = ?`);
      params.push(o.gitBranch);
    }
    if (o.exitCode !== undefined) {
      where.push(`${prefix}exit_code = ?`);
      params.push(o.exitCode);
    }
    if (o.failedOnly) {
      where.push(`${prefix}exit_code IS NOT NULL AND ${prefix}exit_code != 0`);
    }
    if (o.sinceMs !== undefined) {
      where.push(`${prefix}started_at >= ?`);
      params.push(o.sinceMs);
    }
    if (o.untilMs !== undefined) {
      where.push(`${prefix}started_at <= ?`);
      params.push(o.untilMs);
    }
    if (o.sessionId !== undefined) {
      where.push(`${prefix}session_id = ?`);
      params.push(o.sessionId);
    }
  }

  // ------------------------------------------------------------------- misc

  countCommands(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM commands").get() as { n: number };
    return Number(row.n);
  }

  stats(): StoreStats {
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS commands,
                SUM(CASE WHEN exit_code IS NOT NULL AND exit_code != 0 THEN 1 ELSE 0 END) AS failed,
                SUM(redactions) AS redactions,
                MIN(started_at) AS first_at,
                MAX(started_at) AS last_at
         FROM commands`,
      )
      .get() as Record<string, unknown>;
    const sessions = this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {
      n: number;
    };
    const top = this.db
      .prepare(
        "SELECT cwd, COUNT(*) AS n FROM commands GROUP BY cwd ORDER BY n DESC LIMIT 5",
      )
      .all() as { cwd: string; n: number }[];
    let dbSizeBytes: number | null = null;
    if (this.dbPath !== ":memory:") {
      try {
        dbSizeBytes = fs.statSync(this.dbPath).size;
      } catch {
        dbSizeBytes = null;
      }
    }
    return {
      dbPath: this.dbPath,
      dbSizeBytes,
      sessions: Number(sessions.n),
      commands: Number(agg.commands ?? 0),
      failedCommands: Number(agg.failed ?? 0),
      totalRedactions: Number(agg.redactions ?? 0),
      firstCommandAt: agg.first_at === null ? null : Number(agg.first_at),
      lastCommandAt: agg.last_at === null ? null : Number(agg.last_at),
      topCwds: top.map((t) => ({ cwd: String(t.cwd), count: Number(t.n) })),
    };
  }

  /** Delete commands started before `beforeMs`. Returns number deleted. */
  prune(beforeMs: number): number {
    const res = this.db.prepare("DELETE FROM commands WHERE started_at < ?").run(beforeMs);
    this.db
      .prepare(
        `DELETE FROM sessions
         WHERE ended_at IS NOT NULL
           AND id NOT IN (SELECT DISTINCT session_id FROM commands)`,
      )
      .run();
    return Number(res.changes);
  }

  /** Reclaim disk space after pruning (no-op for :memory:). */
  vacuum(): void {
    if (this.dbPath === ":memory:") return;
    this.db.exec("VACUUM;");
  }

  /** Escape hatch for read-only introspection (used by tests). */
  raw(): { prepare: (sql: string) => StatementSync } {
    return this.db;
  }
}
