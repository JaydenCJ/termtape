/**
 * Built-in MCP server: exposes the recorded terminal history to coding
 * agents (Claude Code, Codex, ...) as long-term memory over stdio.
 *
 * All access is read-only. Output stored in the database has already been
 * redacted at record time, so nothing a tool returns can contain a secret
 * the redactor knows how to recognize.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { CommandRecord, SearchHit, Store } from "./store.js";
import { parsePointInTime } from "./time.js";

export const MCP_SERVER_NAME = "termtape";

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function hitToJson(hit: SearchHit) {
  return {
    id: hit.id,
    command: hit.command,
    exit_code: hit.exitCode,
    cwd: hit.cwd,
    git_branch: hit.gitBranch,
    git_root: hit.gitRoot,
    started_at: iso(hit.startedAt),
    duration_ms: hit.durationMs,
    output_snippet: hit.snippet,
  };
}

function commandToJson(cmd: CommandRecord, maxChars: number) {
  let output = cmd.output;
  let outputClipped = false;
  if (output.length > maxChars) {
    const half = Math.floor(maxChars / 2);
    output =
      output.slice(0, half) +
      `\n… [clipped ${output.length - maxChars} chars — fetch with a larger max_chars if needed] …\n` +
      output.slice(output.length - half);
    outputClipped = true;
  }
  return {
    id: cmd.id,
    command: cmd.command,
    exit_code: cmd.exitCode,
    cwd: cmd.cwd,
    git_branch: cmd.gitBranch,
    git_root: cmd.gitRoot,
    git_commit: cmd.gitCommit,
    started_at: iso(cmd.startedAt),
    ended_at: iso(cmd.endedAt),
    duration_ms: cmd.durationMs,
    session_id: cmd.sessionId,
    output_truncated_at_record_time: cmd.truncated,
    output_clipped_for_response: outputClipped,
    output,
  };
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function createMcpServer(store: Store, version = "0.1.0"): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version });

  server.registerTool(
    "search_terminal_history",
    {
      title: "Search terminal history",
      description:
        "Full-text search over the user's recorded terminal history — every command AND its " +
        "complete output, with working directory and git context. Use this whenever the user " +
        "refers to something that happened in their terminal: a past error message, 'that " +
        "command I ran yesterday', a stack trace, a build failure, flags they used, etc. " +
        "The query matches command text, output text, directory paths and git branch names. " +
        "Multi-word queries match documents containing all words. Results are ranked by " +
        "relevance and include an output snippet; call get_command_output with a result id " +
        "to read the full output.",
      inputSchema: {
        query: z.string().describe("Search terms, e.g. 'ENOENT node_modules' or 'migration failed'"),
        cwd: z
          .string()
          .optional()
          .describe("Only match commands run in exactly this working directory"),
        cwd_prefix: z
          .string()
          .optional()
          .describe("Only match commands run in this directory or below (e.g. a project root)"),
        git_branch: z.string().optional().describe("Only match commands run on this git branch"),
        failed_only: z
          .boolean()
          .optional()
          .describe("Only match commands that exited non-zero"),
        since: z
          .string()
          .optional()
          .describe("Time window: a duration like '2h', '7d' or a date like '2026-07-01'"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 10)"),
      },
    },
    async (args) => {
      let sinceMs: number | undefined;
      if (args.since !== undefined) {
        const t = parsePointInTime(args.since);
        if (t === null) return fail(`Could not parse since='${args.since}'. Use '2h', '7d' or '2026-07-01'.`);
        sinceMs = t;
      }
      const hits = store.search({
        query: args.query,
        cwd: args.cwd,
        cwdPrefix: args.cwd_prefix,
        gitBranch: args.git_branch,
        failedOnly: args.failed_only,
        sinceMs,
        limit: args.limit ?? 10,
      });
      return ok({ total_returned: hits.length, results: hits.map(hitToJson) });
    },
  );

  server.registerTool(
    "get_command_output",
    {
      title: "Get full command output",
      description:
        "Fetch one recorded command by id, including its full captured output " +
        "(stdout+stderr as rendered in the terminal), exit code, timing, working directory " +
        "and git context. Use after search_terminal_history or list_recent_commands to read " +
        "the complete output of an interesting command.",
      inputSchema: {
        id: z.number().int().describe("Command id from a previous search/list result"),
        max_chars: z
          .number()
          .int()
          .min(200)
          .max(500_000)
          .optional()
          .describe("Clip output to this many characters (default 20000; head+tail kept)"),
      },
    },
    async (args) => {
      const cmd = store.getCommand(args.id);
      if (!cmd) return fail(`No command with id ${args.id}`);
      return ok(commandToJson(cmd, args.max_chars ?? 20_000));
    },
  );

  server.registerTool(
    "list_recent_commands",
    {
      title: "List recent commands",
      description:
        "List the most recently recorded terminal commands (newest first), optionally " +
        "filtered by working directory or failures only. Useful to see what the user was " +
        "just doing, or to find the last failing command without a search query.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 10)"),
        cwd: z.string().optional().describe("Only commands run in exactly this directory"),
        cwd_prefix: z.string().optional().describe("Only commands run in this directory or below"),
        failed_only: z.boolean().optional().describe("Only commands that exited non-zero"),
        since: z.string().optional().describe("Time window: '2h', '7d' or '2026-07-01'"),
      },
    },
    async (args) => {
      let sinceMs: number | undefined;
      if (args.since !== undefined) {
        const t = parsePointInTime(args.since);
        if (t === null) return fail(`Could not parse since='${args.since}'.`);
        sinceMs = t;
      }
      const rows = store.listCommands({
        limit: args.limit ?? 10,
        cwd: args.cwd,
        cwdPrefix: args.cwd_prefix,
        failedOnly: args.failed_only,
        sinceMs,
      });
      return ok({
        total_returned: rows.length,
        results: rows.map((r) => ({
          id: r.id,
          command: r.command,
          exit_code: r.exitCode,
          cwd: r.cwd,
          git_branch: r.gitBranch,
          started_at: iso(r.startedAt),
          duration_ms: r.durationMs,
        })),
      });
    },
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List recording sessions",
      description:
        "List recorded terminal sessions (newest first) with shell, host, time range and " +
        "command counts. A session is one `termtape record` run.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 10)"),
      },
    },
    async (args) => {
      const sessions = store.listSessions(args.limit ?? 10);
      return ok({
        total_returned: sessions.length,
        results: sessions.map((s) => ({
          id: s.id,
          started_at: iso(s.startedAt),
          ended_at: iso(s.endedAt),
          shell: s.shell,
          host: s.hostname,
          user: s.user,
          mode: s.mode,
          commands: s.commandCount ?? 0,
        })),
      });
    },
  );

  return server;
}

/** Run the MCP server over stdio (used by `termtape mcp`). */
export async function runMcpStdio(store: Store, version?: string): Promise<void> {
  const server = createMcpServer(store, version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
