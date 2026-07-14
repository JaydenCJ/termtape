# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - 2026-07-08 (unreleased)

### Added

- `termtape record`: wrap an interactive bash/zsh session in a pty and record
  every command with its full output, working directory, git branch/commit,
  exit code and duration. Shell hooks are injected via a temporary rc file —
  dotfiles are never modified.
- `termtape record -- <cmd>`: record a single command (exec mode) and
  propagate its exit code.
- Pipe fallback when the optional `node-pty` native module is unavailable
  (recording still works; full-screen TUI programs may misbehave).
- Terminal-text reconstruction: ANSI escape sequences are stripped and
  `\r`/`\b` overwrites are applied, so progress bars collapse to their final
  state before storage.
- SQLite + FTS5 storage on `node:sqlite` (bundled with Node >= 22.13, zero
  native npm dependencies for the storage layer). Database file is created
  `0600` inside a `0700` directory.
- `termtape search`: bm25-ranked full-text search over command text, output,
  cwd and git branch, with `--here`, `--cwd`, `--branch`, `--failed`,
  `--exit`, `--since` and `--json` filters. Raw FTS5 syntax is accepted and
  falls back to literal phrase matching.
- `termtape list` / `show` / `sessions` / `stats` / `prune` commands.
- Automatic secret redaction before storage: 16 built-in rules (AWS, GitHub,
  GitLab, Slack, Anthropic, OpenAI, Stripe, npm, Google, Hugging Face,
  SendGrid keys; JWTs; PEM private key blocks; URL credentials;
  Authorization headers; generic `SECRET=...` assignments), plus custom rules
  and per-rule opt-out via `config.json`. `termtape redact` tests rules from
  the command line.
- Built-in MCP server (`termtape mcp`, stdio): four read-only tools —
  `search_terminal_history`, `get_command_output`, `list_recent_commands`,
  `list_sessions` — exposing the recorded history to coding agents as memory.
- Configuration file (`~/.config/termtape/config.json`): output size cap,
  redaction toggles/custom rules, `ignoreCommands` regex list.
- Unit tests (108) and a self-asserting smoke script covering CLI
  record/search/show/redact and a full MCP initialize → tools/list →
  tools/call round-trip.
- `scripts/mcp-client-check.mjs`: a second, independent MCP verification
  that drives `termtape mcp` with the official `@modelcontextprotocol/sdk`
  client and calls all four tools against a freshly recorded database
  (including a redaction assertion and an invalid-input rejection check).
- ESLint flat config (`eslint.config.js`, `@eslint/js` +
  `typescript-eslint` recommended) and an `npm run lint` script, part of
  the documented local verification sequence (see CONTRIBUTING.md).

### Security

- Exec-mode command lines (`termtape record -- <cmd>`) now pass through the
  redactor before being stored as the session label in `sessions.shell`.
  Before this fix (never published to npm), the raw argv was stored
  unredacted and surfaced via `termtape sessions` and the MCP
  `list_sessions` tool, even though command and output records were always
  redacted. If you recorded secrets on a command line with a pre-release
  build, delete that database file (default
  `~/.local/share/termtape/termtape.db`) or prune the affected sessions —
  redaction at record time cannot retroactively clean old rows.

<!-- Release-tag links are added when the project moves to its standalone
     repository and v0.1.0 is actually tagged and published. -->
