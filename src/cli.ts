#!/usr/bin/env node
/** termtape CLI entry point. */

import os from "node:os";
import { createRequire } from "node:module";

import { Command } from "commander";

import { loadConfig, redactorFromConfig, ignoreRegexesFromConfig } from "./config.js";
import {
  formatBytes,
  formatCommandDetail,
  formatCommandLine,
  formatSearchHit,
  formatSession,
  formatTimestamp,
} from "./format.js";
import { runMcpStdio } from "./mcp.js";
import { StreamParser } from "./parser.js";
import { defaultDbPath } from "./paths.js";
import { createPty } from "./pty.js";
import { CommandAssembler } from "./recorder.js";
import { buildShellIntegration, detectShell } from "./shell.js";
import { Store } from "./store.js";
import { parsePointInTime } from "./time.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const program = new Command();

program
  .name("termtape")
  .description(
    "A flight recorder for your terminal: every command + full output,\n" +
      "with cwd/git context, full-text searchable, auto-redacted, and\n" +
      "exposed to coding agents via a built-in MCP server.",
  )
  .version(pkg.version)
  .option("--db <path>", "database file (default: $TERMTAPE_DB or ~/.local/share/termtape/termtape.db)");

function openStore(): Store {
  const opts = program.opts<{ db?: string }>();
  return new Store(opts.db ?? defaultDbPath());
}

function resolveSince(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const t = parsePointInTime(value);
  if (t === null) {
    process.stderr.write(`termtape: cannot parse ${flag} '${value}' (use e.g. 2h, 7d, 2026-07-01)\n`);
    process.exit(2);
  }
  return t;
}

// ------------------------------------------------------------------ record

program
  .command("record")
  .description("record a shell session (or a single command after --)")
  .option("--shell <path>", "shell to launch (default: $SHELL)")
  .argument("[command...]", "run a single command instead of an interactive shell")
  .action(async (commandArgs: string[], cmdOpts: { shell?: string }) => {
    if (process.env.TERMTAPE_SESSION) {
      process.stderr.write("termtape: already recording (TERMTAPE_SESSION is set); refusing to nest.\n");
      process.exit(1);
    }
    const cfg = loadConfig();
    const store = openStore();
    const redactor = redactorFromConfig(cfg);
    const ignore = ignoreRegexesFromConfig(cfg);
    const mode: "interactive" | "exec" = commandArgs.length > 0 ? "exec" : "interactive";

    const shellPath = cmdOpts.shell ?? detectShell();
    // In exec mode the joined argv becomes the session's label — it can carry
    // secrets (e.g. `termtape record -- curl -H "Authorization: ..."`), so it
    // must pass through the redactor like everything else that touches disk.
    const sessionId = store.createSession({
      shell: mode === "exec" ? redactor.redact(commandArgs.join(" ")).text : shellPath,
      hostname: os.hostname(),
      user: os.userInfo().username,
      mode,
    });

    let recorded = 0;
    const assembler = new CommandAssembler(
      (cmd) => {
        store.insertCommand({
          sessionId,
          command: cmd.command,
          output: cmd.output,
          exitCode: cmd.exitCode,
          cwd: cmd.cwd,
          gitRoot: cmd.git?.root ?? null,
          gitBranch: cmd.git?.branch ?? null,
          gitCommit: cmd.git?.commit ?? null,
          startedAt: cmd.startedAt,
          endedAt: cmd.endedAt,
          redactions: cmd.redactions,
          outputBytes: cmd.outputBytes,
          truncated: cmd.truncated,
        });
        recorded++;
      },
      { redactor, maxOutputBytes: cfg.maxOutputBytes, ignore },
    );
    const parser = new StreamParser();

    let file: string;
    let args: string[];
    let envAdd: Record<string, string> = { TERMTAPE_SESSION: sessionId };
    let cleanup: () => void = () => {};

    if (mode === "exec") {
      file = commandArgs[0]!;
      args = commandArgs.slice(1);
      assembler.handleMarker({
        type: "pre",
        command: commandArgs.join(" "),
        cwd: process.cwd(),
      });
    } else {
      const integration = buildShellIntegration(shellPath, { sessionId });
      if (!integration.supported) {
        process.stderr.write(
          `termtape: no per-command hooks for shell '${integration.shellName}' ` +
            `(bash and zsh are supported); commands will not be recorded.\n` +
            `termtape: tip — record single commands with: termtape record -- <cmd>\n`,
        );
      }
      file = integration.file;
      args = integration.args;
      envAdd = { ...envAdd, ...integration.env };
      cleanup = integration.cleanup;
    }

    const ptyProc = await createPty(file, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...envAdd },
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    });
    if (ptyProc.backend === "pipe") {
      process.stderr.write(
        "termtape: node-pty unavailable — falling back to pipes " +
          "(recording still works; full-screen/TUI programs may misbehave).\n",
      );
    }

    const stdinIsTTY = process.stdin.isTTY === true;
    if (stdinIsTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const onStdin = (d: Buffer) => ptyProc.write(d.toString("utf8"));
    process.stdin.on("data", onStdin);

    const onResize = () =>
      ptyProc.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    process.stdout.on("resize", onResize);

    ptyProc.onData((data) => {
      for (const ev of parser.push(data)) {
        if (ev.type === "output") {
          process.stdout.write(ev.data);
          assembler.handleOutput(ev.data);
        } else {
          assembler.handleMarker(ev.marker);
        }
      }
    });

    ptyProc.onExit((code) => {
      for (const ev of parser.flush()) {
        if (ev.type === "output") {
          process.stdout.write(ev.data);
          assembler.handleOutput(ev.data);
        } else {
          assembler.handleMarker(ev.marker);
        }
      }
      if (mode === "exec") {
        assembler.handleMarker({ type: "post", exitCode: code });
      } else {
        assembler.finalize();
      }
      store.endSession(sessionId);
      cleanup();
      process.stdin.off("data", onStdin);
      if (stdinIsTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write(
        `\ntermtape: recorded ${recorded} command(s) → ${store.dbPath}\n`,
      );
      store.close();
      process.exit(mode === "exec" ? (code ?? 0) : 0);
    });
  });

// ------------------------------------------------------------------ search

program
  .command("search")
  .description("full-text search over commands and their output")
  .argument("<query...>", "search terms (FTS5 syntax allowed; falls back to literal)")
  .option("-n, --limit <n>", "max results", "10")
  .option("--cwd <dir>", "only commands run in exactly this directory")
  .option("--here", "only commands run under the current directory")
  .option("--branch <name>", "only commands run on this git branch")
  .option("--failed", "only commands that exited non-zero")
  .option("--exit <code>", "only commands with this exit code")
  .option("--since <when>", "e.g. 2h, 7d, 2026-07-01")
  .option("--json", "output JSON")
  .action((queryParts: string[], opts) => {
    const store = openStore();
    const hits = store.search({
      query: queryParts.join(" "),
      cwd: opts.cwd,
      cwdPrefix: opts.here ? process.cwd() : undefined,
      gitBranch: opts.branch,
      failedOnly: opts.failed === true,
      exitCode: opts.exit !== undefined ? Number.parseInt(opts.exit, 10) : undefined,
      sinceMs: resolveSince(opts.since, "--since"),
      limit: Number.parseInt(opts.limit, 10),
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
    } else if (hits.length === 0) {
      process.stdout.write("no matches\n");
    } else {
      process.stdout.write(hits.map(formatSearchHit).join("\n") + "\n");
    }
    store.close();
  });

// -------------------------------------------------------------------- list

program
  .command("list")
  .description("list recent commands (newest first)")
  .option("-n, --limit <n>", "max results", "20")
  .option("--cwd <dir>", "only commands run in exactly this directory")
  .option("--here", "only commands run under the current directory")
  .option("--failed", "only commands that exited non-zero")
  .option("--session <id>", "only commands from this session")
  .option("--since <when>", "e.g. 2h, 7d, 2026-07-01")
  .option("--json", "output JSON")
  .action((opts) => {
    const store = openStore();
    const rows = store.listCommands({
      limit: Number.parseInt(opts.limit, 10),
      cwd: opts.cwd,
      cwdPrefix: opts.here ? process.cwd() : undefined,
      failedOnly: opts.failed === true,
      sessionId: opts.session,
      sinceMs: resolveSince(opts.since, "--since"),
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else if (rows.length === 0) {
      process.stdout.write("nothing recorded yet — try: termtape record\n");
    } else {
      process.stdout.write(rows.map(formatCommandLine).join("\n") + "\n");
    }
    store.close();
  });

// -------------------------------------------------------------------- show

program
  .command("show")
  .description("show one recorded command with its full output")
  .argument("<id>", "command id (see list/search)")
  .option("--json", "output JSON")
  .action((idArg: string, opts) => {
    const store = openStore();
    const id = Number.parseInt(idArg.replace(/^#/, ""), 10);
    const cmd = store.getCommand(id);
    if (!cmd) {
      process.stderr.write(`termtape: no command with id ${idArg}\n`);
      store.close();
      process.exit(1);
    }
    process.stdout.write(
      (opts.json ? JSON.stringify(cmd, null, 2) : formatCommandDetail(cmd)) + "\n",
    );
    store.close();
  });

// ---------------------------------------------------------------- sessions

program
  .command("sessions")
  .description("list recording sessions")
  .option("-n, --limit <n>", "max results", "20")
  .option("--json", "output JSON")
  .action((opts) => {
    const store = openStore();
    const sessions = store.listSessions(Number.parseInt(opts.limit, 10));
    if (opts.json) {
      process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
    } else if (sessions.length === 0) {
      process.stdout.write("no sessions recorded yet\n");
    } else {
      process.stdout.write(sessions.map(formatSession).join("\n") + "\n");
    }
    store.close();
  });

// ------------------------------------------------------------------- stats

program
  .command("stats")
  .description("database statistics")
  .option("--json", "output JSON")
  .action((opts) => {
    const store = openStore();
    const s = store.stats();
    if (opts.json) {
      process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    } else {
      const lines = [
        `database    ${s.dbPath}${s.dbSizeBytes !== null ? ` (${formatBytes(s.dbSizeBytes)})` : ""}`,
        `sessions    ${s.sessions}`,
        `commands    ${s.commands} (${s.failedCommands} failed)`,
        `redactions  ${s.totalRedactions} secret(s) scrubbed before storage`,
      ];
      if (s.firstCommandAt !== null && s.lastCommandAt !== null) {
        lines.push(
          `range       ${formatTimestamp(s.firstCommandAt)} → ${formatTimestamp(s.lastCommandAt)}`,
        );
      }
      if (s.topCwds.length > 0) {
        lines.push("top dirs:");
        for (const t of s.topCwds) lines.push(`  ${String(t.count).padStart(6)}  ${t.cwd}`);
      }
      process.stdout.write(lines.join("\n") + "\n");
    }
    store.close();
  });

// ------------------------------------------------------------------- prune

program
  .command("prune")
  .description("delete old commands")
  .requiredOption("--older-than <when>", "e.g. 90d, 2026-01-01")
  .option("--vacuum", "reclaim disk space afterwards")
  .action((opts) => {
    const before = resolveSince(opts.olderThan, "--older-than")!;
    const store = openStore();
    const n = store.prune(before);
    if (opts.vacuum) store.vacuum();
    process.stdout.write(`pruned ${n} command(s) older than ${formatTimestamp(before)}\n`);
    store.close();
  });

// ------------------------------------------------------------------ redact

program
  .command("redact")
  .description("test the redaction rules against a string (or list them)")
  .argument("[text...]", "text to redact (reads stdin when omitted)")
  .option("--list", "list active redaction rules")
  .action(async (textParts: string[], opts) => {
    const cfg = loadConfig();
    const redactor = redactorFromConfig(cfg);
    if (opts.list) {
      for (const rule of redactor.listRules()) {
        process.stdout.write(`${rule.id.padEnd(24)} ${rule.description}\n`);
      }
      return;
    }
    let input = textParts.join(" ");
    if (input === "") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      input = Buffer.concat(chunks).toString("utf8");
    }
    const result = redactor.redact(input);
    process.stdout.write(result.text + (result.text.endsWith("\n") ? "" : "\n"));
    process.stderr.write(`termtape: ${result.total} redaction(s)\n`);
  });

// --------------------------------------------------------------------- mcp

program
  .command("mcp")
  .description("run the MCP server on stdio (read-only history access for agents)")
  .action(async () => {
    const store = openStore();
    await runMcpStdio(store, pkg.version);
    // Keep the process alive; transport closes when stdin closes.
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`termtape: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
