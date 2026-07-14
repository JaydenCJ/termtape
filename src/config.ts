import fs from "node:fs";

import { defaultConfigPath } from "./paths.js";
import { Redactor, type RedactionRule } from "./redact.js";

export interface TermtapeConfig {
  /** Max bytes of output stored per command (head + tail are kept). */
  maxOutputBytes: number;
  redact: {
    enabled: boolean;
    /** Default rule ids to disable. */
    disable: string[];
    /** Custom rules: { id, pattern, flags? } — pattern is a JS regex source. */
    custom: { id: string; pattern: string; flags?: string; description?: string }[];
  };
  /**
   * Commands matching any of these regexes are not recorded at all
   * (e.g. ["^ ", "vault kv get"] — note atuin-style leading-space opt-out).
   */
  ignoreCommands: string[];
}

export const DEFAULT_CONFIG: TermtapeConfig = {
  maxOutputBytes: 2 * 1024 * 1024,
  redact: { enabled: true, disable: [], custom: [] },
  ignoreCommands: [],
};

export function loadConfig(file: string = defaultConfigPath()): TermtapeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (typeof raw !== "object" || raw === null) return cfg;
  const r = raw as Record<string, unknown>;
  if (typeof r.maxOutputBytes === "number" && r.maxOutputBytes > 0) {
    cfg.maxOutputBytes = Math.floor(r.maxOutputBytes);
  }
  if (Array.isArray(r.ignoreCommands)) {
    cfg.ignoreCommands = r.ignoreCommands.filter((x): x is string => typeof x === "string");
  }
  if (typeof r.redact === "object" && r.redact !== null) {
    const rr = r.redact as Record<string, unknown>;
    if (typeof rr.enabled === "boolean") cfg.redact.enabled = rr.enabled;
    if (Array.isArray(rr.disable)) {
      cfg.redact.disable = rr.disable.filter((x): x is string => typeof x === "string");
    }
    if (Array.isArray(rr.custom)) {
      for (const c of rr.custom) {
        if (
          typeof c === "object" &&
          c !== null &&
          typeof (c as Record<string, unknown>).id === "string" &&
          typeof (c as Record<string, unknown>).pattern === "string"
        ) {
          const cc = c as { id: string; pattern: string; flags?: string; description?: string };
          cfg.redact.custom.push(cc);
        }
      }
    }
  }
  return cfg;
}

export function redactorFromConfig(cfg: TermtapeConfig): Redactor {
  const custom: RedactionRule[] = [];
  for (const c of cfg.redact.custom) {
    try {
      const flags = c.flags ?? "g";
      custom.push({
        id: c.id,
        description: c.description ?? "custom rule",
        pattern: new RegExp(c.pattern, flags.includes("g") ? flags : flags + "g"),
      });
    } catch {
      // Invalid custom pattern: skip rather than break recording.
    }
  }
  return new Redactor({
    enabled: cfg.redact.enabled,
    disable: cfg.redact.disable,
    custom,
  });
}

export function ignoreRegexesFromConfig(cfg: TermtapeConfig): RegExp[] {
  const out: RegExp[] = [];
  for (const src of cfg.ignoreCommands) {
    try {
      out.push(new RegExp(src));
    } catch {
      // skip invalid
    }
  }
  return out;
}
