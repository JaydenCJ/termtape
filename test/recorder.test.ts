import { describe, expect, it } from "vitest";

import { CommandAssembler, type AssembledCommand } from "../src/recorder.js";
import { Redactor } from "../src/redact.js";

function makeAssembler(options: ConstructorParameters<typeof CommandAssembler>[1] = {}) {
  const out: AssembledCommand[] = [];
  const assembler = new CommandAssembler((c) => out.push(c), {
    resolveGit: () => null,
    ...options,
  });
  return { assembler, out };
}

describe("CommandAssembler", () => {
  it("assembles a simple command from pre/output/post", () => {
    const { assembler, out } = makeAssembler();
    assembler.handleMarker({ type: "pre", command: "ls -la", cwd: "/tmp" });
    assembler.handleOutput(Buffer.from("file1\nfile2\n"));
    assembler.handleMarker({ type: "post", exitCode: 0 });
    expect(out).toHaveLength(1);
    expect(out[0]!.command).toBe("ls -la");
    expect(out[0]!.cwd).toBe("/tmp");
    expect(out[0]!.output).toBe("file1\nfile2\n");
    expect(out[0]!.exitCode).toBe(0);
    expect(out[0]!.truncated).toBe(false);
  });

  it("discards output outside of a command (prompt noise)", () => {
    const { assembler, out } = makeAssembler();
    assembler.handleOutput(Buffer.from("user@host $ "));
    assembler.handleMarker({ type: "pre", command: "true", cwd: "/" });
    assembler.handleMarker({ type: "post", exitCode: 0 });
    assembler.handleOutput(Buffer.from("user@host $ "));
    expect(out).toHaveLength(1);
    expect(out[0]!.output).toBe("");
  });

  it("handles several commands in sequence", () => {
    const { assembler, out } = makeAssembler();
    for (let i = 0; i < 3; i++) {
      assembler.handleMarker({ type: "pre", command: `cmd${i}`, cwd: "/" });
      assembler.handleOutput(Buffer.from(`out${i}`));
      assembler.handleMarker({ type: "post", exitCode: i });
    }
    expect(out.map((c) => [c.command, c.output, c.exitCode])).toEqual([
      ["cmd0", "out0", 0],
      ["cmd1", "out1", 1],
      ["cmd2", "out2", 2],
    ]);
  });

  it("closes a dangling command when a new pre arrives (missing post)", () => {
    const { assembler, out } = makeAssembler();
    assembler.handleMarker({ type: "pre", command: "crashy", cwd: "/" });
    assembler.handleOutput(Buffer.from("partial"));
    assembler.handleMarker({ type: "pre", command: "next", cwd: "/" });
    assembler.handleMarker({ type: "post", exitCode: 0 });
    expect(out).toHaveLength(2);
    expect(out[0]!.command).toBe("crashy");
    expect(out[0]!.exitCode).toBeNull();
    expect(out[1]!.command).toBe("next");
  });

  it("finalize() flushes a still-open command", () => {
    const { assembler, out } = makeAssembler();
    assembler.handleMarker({ type: "pre", command: "long-runner", cwd: "/" });
    assembler.handleOutput(Buffer.from("working...\n"));
    assembler.finalize();
    expect(out).toHaveLength(1);
    expect(out[0]!.exitCode).toBeNull();
    expect(out[0]!.output).toBe("working...\n");
  });

  it("renders ANSI/progress output before storing", () => {
    const { assembler, out } = makeAssembler();
    assembler.handleMarker({ type: "pre", command: "download", cwd: "/" });
    assembler.handleOutput(Buffer.from("\x1b[32m10%\r55%\r100%\x1b[0m\ndone\n"));
    assembler.handleMarker({ type: "post", exitCode: 0 });
    expect(out[0]!.output).toBe("100%\ndone\n");
  });

  it("redacts secrets in command and output and counts them", () => {
    const { assembler, out } = makeAssembler({ redactor: new Redactor() });
    assembler.handleMarker({
      type: "pre",
      command: "export TOKEN=ghp_" + "a1B2".repeat(9),
      cwd: "/",
    });
    assembler.handleOutput(Buffer.from("your key: AKIAIOSFODNN7EXAMPLE\n"));
    assembler.handleMarker({ type: "post", exitCode: 0 });
    expect(out[0]!.command).not.toContain("ghp_");
    expect(out[0]!.output).toContain("[REDACTED:aws-access-key-id]");
    expect(out[0]!.redactions).toBe(2);
  });

  it("truncates huge output keeping head and tail", () => {
    const { assembler, out } = makeAssembler({ maxOutputBytes: 1000 });
    assembler.handleMarker({ type: "pre", command: "yes", cwd: "/" });
    assembler.handleOutput(Buffer.from("HEAD-MARKER ".padEnd(400, "h")));
    for (let i = 0; i < 100; i++) assembler.handleOutput(Buffer.from(`middle-${i} `.padEnd(100, "m")));
    assembler.handleOutput(Buffer.from("TAIL-MARKER".padStart(400, "t")));
    assembler.handleMarker({ type: "post", exitCode: 0 });
    const cmd = out[0]!;
    expect(cmd.truncated).toBe(true);
    expect(cmd.output).toContain("HEAD-MARKER");
    expect(cmd.output).toContain("TAIL-MARKER");
    expect(cmd.output).toContain("bytes of output truncated");
    expect(cmd.outputBytes).toBeGreaterThan(10_000);
    // Stored text stays bounded.
    expect(cmd.output.length).toBeLessThan(2000);
  });

  it("does not truncate output exactly at the limit", () => {
    const { assembler, out } = makeAssembler({ maxOutputBytes: 100 });
    assembler.handleMarker({ type: "pre", command: "x", cwd: "/" });
    assembler.handleOutput(Buffer.from("a".repeat(100)));
    assembler.handleMarker({ type: "post", exitCode: 0 });
    expect(out[0]!.truncated).toBe(false);
    expect(out[0]!.output).toBe("a".repeat(100));
  });

  it("skips empty commands and ignore-listed commands", () => {
    const { assembler, out } = makeAssembler({ ignore: [/^secret-tool /] });
    assembler.handleMarker({ type: "pre", command: "   ", cwd: "/" });
    assembler.handleMarker({ type: "post", exitCode: 0 });
    assembler.handleMarker({ type: "pre", command: "secret-tool lookup", cwd: "/" });
    assembler.handleMarker({ type: "post", exitCode: 0 });
    assembler.handleMarker({ type: "pre", command: "normal", cwd: "/" });
    assembler.handleMarker({ type: "post", exitCode: 0 });
    expect(out.map((c) => c.command)).toEqual(["normal"]);
    expect(assembler.skipped).toBe(2);
  });

  it("attaches git context from the injected resolver", () => {
    const outArr: AssembledCommand[] = [];
    const assembler = new CommandAssembler((c) => outArr.push(c), {
      resolveGit: (cwd) => ({ root: cwd, branch: "feature/z", commit: "c".repeat(40) }),
    });
    assembler.handleMarker({ type: "pre", command: "git log", cwd: "/repo" });
    assembler.handleMarker({ type: "post", exitCode: 0 });
    expect(outArr[0]!.git).toEqual({ root: "/repo", branch: "feature/z", commit: "c".repeat(40) });
  });

  it("uses the injected clock for timing", () => {
    let t = 1000;
    const outArr: AssembledCommand[] = [];
    const assembler = new CommandAssembler((c) => outArr.push(c), {
      resolveGit: () => null,
      now: () => (t += 500),
    });
    assembler.handleMarker({ type: "pre", command: "sleep", cwd: "/" });
    assembler.handleMarker({ type: "post", exitCode: 0 });
    expect(outArr[0]!.startedAt).toBe(1500);
    expect(outArr[0]!.endedAt).toBe(2000);
  });
});
