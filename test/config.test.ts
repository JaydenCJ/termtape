import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  ignoreRegexesFromConfig,
  loadConfig,
  redactorFromConfig,
} from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "termtape-cfg-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when the file is missing", () => {
    const cfg = loadConfig(path.join(dir, "nope.json"));
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults for invalid JSON", () => {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{nope");
    expect(loadConfig(file)).toEqual(DEFAULT_CONFIG);
  });

  it("merges user settings over defaults", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        maxOutputBytes: 4096,
        ignoreCommands: ["^vault ", 123],
        redact: {
          disable: ["generic-assignment"],
          custom: [{ id: "corp", pattern: "CORP-[0-9]{8}" }],
        },
      }),
    );
    const cfg = loadConfig(file);
    expect(cfg.maxOutputBytes).toBe(4096);
    expect(cfg.ignoreCommands).toEqual(["^vault "]);
    expect(cfg.redact.enabled).toBe(true);
    expect(cfg.redact.disable).toEqual(["generic-assignment"]);
    expect(cfg.redact.custom).toHaveLength(1);
  });
});

describe("redactorFromConfig", () => {
  it("applies custom rules and disabled ids", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        redact: {
          disable: ["generic-assignment"],
          custom: [{ id: "corp-ticket", pattern: "CORP-[0-9]{8}" }],
        },
      }),
    );
    const r = redactorFromConfig(loadConfig(file));
    const out = r.redact("PASSWORD=notredacted1 and CORP-12345678");
    expect(out.text).toContain("PASSWORD=notredacted1");
    expect(out.text).toContain("[REDACTED:corp-ticket]");
  });

  it("skips invalid custom patterns instead of crashing", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ redact: { custom: [{ id: "broken", pattern: "([" }] } }),
    );
    const r = redactorFromConfig(loadConfig(file));
    expect(r.redact("hello").text).toBe("hello");
  });
});

describe("ignoreRegexesFromConfig", () => {
  it("compiles valid regexes and drops invalid ones", () => {
    const regs = ignoreRegexesFromConfig({
      ...DEFAULT_CONFIG,
      ignoreCommands: ["^secret", "(["],
    });
    expect(regs).toHaveLength(1);
    expect(regs[0]!.test("secret-tool")).toBe(true);
  });
});
