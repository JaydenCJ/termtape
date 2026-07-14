/** termtape public API (for embedding / testing). */

export { renderTerminalText } from "./ansi.js";
export {
  DEFAULT_CONFIG,
  loadConfig,
  redactorFromConfig,
  ignoreRegexesFromConfig,
  type TermtapeConfig,
} from "./config.js";
export { resolveGitContext, type GitContext } from "./git.js";
export {
  BEL,
  OSC_MARKER_PREFIX,
  ST,
  decodeMarkerPayload,
  encodePostMarker,
  encodePreMarker,
  type Marker,
} from "./markers.js";
export { createMcpServer, runMcpStdio, MCP_SERVER_NAME } from "./mcp.js";
export { StreamParser, type ParserEvent } from "./parser.js";
export { defaultConfigPath, defaultDbPath } from "./paths.js";
export { createPty, type PtyProcess, type PtyOptions } from "./pty.js";
export {
  CommandAssembler,
  type AssembledCommand,
  type AssemblerOptions,
} from "./recorder.js";
export {
  DEFAULT_RULES,
  Redactor,
  type RedactionResult,
  type RedactionRule,
  type RedactorOptions,
} from "./redact.js";
export {
  bashShim,
  buildShellIntegration,
  detectShell,
  zshEnvShim,
  zshShim,
  type ShellIntegration,
} from "./shell.js";
export {
  Store,
  quoteFtsQuery,
  type CommandInput,
  type CommandRecord,
  type ListOptions,
  type SearchHit,
  type SearchOptions,
  type SessionRecord,
  type StoreStats,
} from "./store.js";
export { formatDuration, parseDuration, parsePointInTime } from "./time.js";
