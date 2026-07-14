# Contributing to termtape

Thanks for your interest in improving termtape. Bug reports, feature
discussions and pull requests are all welcome.

## Development setup

Requirements: Node.js >= 22.13 (termtape uses the built-in `node:sqlite`
module, unflagged since 22.13).

```bash
git clone https://github.com/JaydenCJ/termtape.git
cd termtape
npm install
npm run build
npm test
```

Useful commands:

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | ESLint (flat config) over `src/`, `test/` and `scripts/` |
| `npm test` | Run the vitest unit suite |
| `bash scripts/smoke.sh` | End-to-end smoke test (CLI + MCP round-trip) |
| `node scripts/mcp-client-check.mjs` | Drive the built-in MCP server with the official SDK client |
| `node dist/cli.js …` | Run the CLI from your working tree |

## Project layout

```
src/
  markers.ts   OSC 7770 marker protocol (encode/decode)
  parser.ts    incremental pty stream splitter (output vs markers)
  recorder.ts  CommandAssembler: markers + bytes -> command records
  ansi.ts      terminal-text reconstruction (strip ANSI, apply \r and \b)
  redact.ts    secret redaction rules and engine
  git.ts       git context resolution (pure filesystem, no subprocess)
  store.ts     SQLite + FTS5 storage (node:sqlite)
  mcp.ts       built-in MCP server (4 read-only tools)
  shell.ts     bash/zsh hook shims
  pty.ts       node-pty backend with pipe fallback
  cli.ts       command-line interface
test/          vitest unit tests, one file per module
scripts/       smoke.sh, mcp-client-check.mjs
```

## Guidelines

- **Tests first-class**: every behavior change needs a unit test. The pure
  modules (`parser`, `recorder`, `ansi`, `redact`, `git`, `store`, `time`)
  are dependency-injected and test without a real terminal.
- **Redaction rules**: new rules must come with positive and negative test
  cases (real-format sample tokens that must match, near-misses that must
  not). Never commit a live credential — use documented example values.
- **No network at test time**: unit tests and `scripts/smoke.sh` must run
  fully offline.
- **Comments and identifiers in English.**
- **Compatibility**: the storage layer must keep working with plain
  `node:sqlite`; do not add native npm dependencies to the core path.
  `node-pty` stays optional.

## Reporting bugs

Please include: your OS and shell (`bash --version` / `zsh --version`), Node
version, the command you ran, and the output of `termtape stats`. If the bug
involves recording, a minimal reproduction script helps a lot.

## Security

If you find a way to make a secret bypass redaction, please do not open a
public issue with the token format exploit spelled out — email the maintainer
(see `package.json`) or open a private security advisory on GitHub.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
