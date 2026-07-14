import { describe, expect, it } from "vitest";

import { encodePostMarker, encodePreMarker } from "../src/markers.js";
import { StreamParser, type ParserEvent } from "../src/parser.js";

function collectText(events: ParserEvent[]): string {
  return events
    .filter((e): e is Extract<ParserEvent, { type: "output" }> => e.type === "output")
    .map((e) => e.data.toString("utf8"))
    .join("");
}

function collectMarkers(events: ParserEvent[]) {
  return events
    .filter((e): e is Extract<ParserEvent, { type: "marker" }> => e.type === "marker")
    .map((e) => e.marker);
}

describe("StreamParser", () => {
  it("passes plain output through unchanged", () => {
    const p = new StreamParser();
    const events = [...p.push("hello "), ...p.push("world"), ...p.flush()];
    expect(collectText(events)).toBe("hello world");
    expect(collectMarkers(events)).toEqual([]);
  });

  it("extracts markers and strips them from the output", () => {
    const p = new StreamParser();
    const stream =
      "prompt$ " + encodePreMarker("ls", "/tmp") + "file1\nfile2\n" + encodePostMarker(0) + "prompt$ ";
    const events = [...p.push(stream), ...p.flush()];
    expect(collectText(events)).toBe("prompt$ file1\nfile2\nprompt$ ");
    expect(collectMarkers(events)).toEqual([
      { type: "pre", command: "ls", cwd: "/tmp" },
      { type: "post", exitCode: 0 },
    ]);
  });

  it("handles markers split across arbitrary chunk boundaries (byte-by-byte)", () => {
    const stream =
      "before" + encodePreMarker("npm test", "/proj") + "output" + encodePostMarker(1) + "after";
    const buf = Buffer.from(stream, "utf8");
    const p = new StreamParser();
    const events: ParserEvent[] = [];
    for (let i = 0; i < buf.length; i++) {
      events.push(...p.push(buf.subarray(i, i + 1)));
    }
    events.push(...p.flush());
    expect(collectText(events)).toBe("beforeoutputafter");
    expect(collectMarkers(events)).toEqual([
      { type: "pre", command: "npm test", cwd: "/proj" },
      { type: "post", exitCode: 1 },
    ]);
  });

  it("handles ST-terminated markers", () => {
    const p = new StreamParser();
    const marker = "\x1b]7770;post;7\x1b\\";
    const events = [...p.push("a" + marker + "b"), ...p.flush()];
    expect(collectText(events)).toBe("ab");
    expect(collectMarkers(events)).toEqual([{ type: "post", exitCode: 7 }]);
  });

  it("leaves foreign OSC sequences (e.g. window title) untouched", () => {
    const p = new StreamParser();
    const input = "\x1b]0;my title\x07text\x1b]777;notify\x07";
    const events = [...p.push(input), ...p.flush()];
    expect(collectText(events)).toBe(input);
  });

  it("does not confuse an OSC 77700 sequence with a marker", () => {
    // Prefix requires the ';' right after 7770.
    const p = new StreamParser();
    const input = "\x1b]77700;x\x07rest";
    const events = [...p.push(input), ...p.flush()];
    expect(collectText(events)).toBe(input);
    expect(collectMarkers(events)).toEqual([]);
  });

  it("drops malformed termtape markers silently", () => {
    const p = new StreamParser();
    const events = [...p.push("a\x1b]7770;garbage\x07b"), ...p.flush()];
    expect(collectText(events)).toBe("ab");
    expect(collectMarkers(events)).toEqual([]);
  });

  it("re-emits an unterminated marker as raw output on flush", () => {
    const p = new StreamParser();
    const events = [...p.push("x\x1b]7770;pre;abc"), ...p.flush()];
    expect(collectText(events)).toBe("x\x1b]7770;pre;abc");
  });

  it("bails out of absurdly long unterminated markers", () => {
    const p = new StreamParser();
    const events: ParserEvent[] = [];
    events.push(...p.push("\x1b]7770;"));
    for (let i = 0; i < 70; i++) {
      events.push(...p.push("A".repeat(1024)));
    }
    events.push(...p.flush());
    expect(collectMarkers(events)).toEqual([]);
    expect(collectText(events)).toContain("\x1b]7770;");
    expect(collectText(events).length).toBeGreaterThan(70 * 1024);
  });

  it("holds back a partial marker prefix at a chunk boundary", () => {
    const p = new StreamParser();
    const first = p.push("data\x1b]77");
    // The ESC]77 could still become a marker: must not be emitted yet.
    expect(collectText(first)).toBe("data");
    const second = p.push("70;post;0\x07more");
    expect(collectText(second)).toBe("more");
    expect(collectMarkers(second)).toEqual([{ type: "post", exitCode: 0 }]);
  });

  it("releases a held partial prefix that turns out to be ordinary output", () => {
    const p = new StreamParser();
    const events = [...p.push("data\x1b]77"), ...p.push("xyz"), ...p.flush()];
    expect(collectText(events)).toBe("data\x1b]77xyz");
  });
});
