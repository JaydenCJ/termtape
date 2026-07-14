import { describe, expect, it } from "vitest";

import {
  decodeMarkerPayload,
  encodePostMarker,
  encodePreMarker,
  OSC_MARKER_PREFIX,
  BEL,
} from "../src/markers.js";

describe("marker protocol", () => {
  it("round-trips a pre marker", () => {
    const encoded = encodePreMarker("git status", "/home/me/project");
    expect(encoded.startsWith(OSC_MARKER_PREFIX)).toBe(true);
    expect(encoded.endsWith(BEL)).toBe(true);
    const payload = encoded.slice(OSC_MARKER_PREFIX.length, -1);
    expect(decodeMarkerPayload(payload)).toEqual({
      type: "pre",
      command: "git status",
      cwd: "/home/me/project",
    });
  });

  it("round-trips commands containing semicolons, quotes and unicode", () => {
    const cmd = `echo "a;b" && printf '%s' 'ключ' # 日本語`;
    const encoded = encodePreMarker(cmd, "/tmp/ディレクトリ");
    const payload = encoded.slice(OSC_MARKER_PREFIX.length, -1);
    const decoded = decodeMarkerPayload(payload);
    expect(decoded).toEqual({ type: "pre", command: cmd, cwd: "/tmp/ディレクトリ" });
  });

  it("round-trips post markers", () => {
    expect(decodeMarkerPayload("post;0")).toEqual({ type: "post", exitCode: 0 });
    expect(decodeMarkerPayload("post;130")).toEqual({ type: "post", exitCode: 130 });
    const enc = encodePostMarker(42);
    expect(decodeMarkerPayload(enc.slice(OSC_MARKER_PREFIX.length, -1))).toEqual({
      type: "post",
      exitCode: 42,
    });
  });

  it("treats missing/invalid exit codes as null", () => {
    expect(decodeMarkerPayload("post;")).toEqual({ type: "post", exitCode: null });
    expect(decodeMarkerPayload("post;abc")).toEqual({ type: "post", exitCode: null });
    expect(decodeMarkerPayload("post")).toEqual({ type: "post", exitCode: null });
  });

  it("rejects malformed payloads", () => {
    expect(decodeMarkerPayload("")).toBeNull();
    expect(decodeMarkerPayload("nonsense")).toBeNull();
    expect(decodeMarkerPayload("pre;onlyonepart")).toBeNull();
    expect(decodeMarkerPayload("pre;***not-base64***;also-bad")).toBeNull();
  });
});
