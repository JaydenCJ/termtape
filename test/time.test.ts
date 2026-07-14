import { describe, expect, it } from "vitest";

import { formatDuration, parseDuration, parsePointInTime } from "../src/time.js";

describe("parseDuration", () => {
  it("parses common units", () => {
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
    expect(parseDuration("2w")).toBe(14 * 86_400_000);
    expect(parseDuration("1.5h")).toBe(5_400_000);
  });

  it("rejects garbage", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("h")).toBeNull();
    expect(parseDuration("10x")).toBeNull();
    expect(parseDuration("yesterday")).toBeNull();
  });
});

describe("parsePointInTime", () => {
  const now = Date.parse("2026-07-08T12:00:00Z");

  it("resolves relative durations against now", () => {
    expect(parsePointInTime("2h", now)).toBe(now - 7_200_000);
    expect(parsePointInTime("7d", now)).toBe(now - 7 * 86_400_000);
  });

  it("parses ISO dates and datetimes", () => {
    expect(parsePointInTime("2026-07-01", now)).toBe(Date.parse("2026-07-01"));
    expect(parsePointInTime("2026-07-01T08:30:00Z", now)).toBe(
      Date.parse("2026-07-01T08:30:00Z"),
    );
  });

  it("returns null for unparseable input", () => {
    expect(parsePointInTime("not-a-time", now)).toBeNull();
    expect(parsePointInTime("07/01/2026", now)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats ranges", () => {
    expect(formatDuration(12)).toBe("12ms");
    expect(formatDuration(2_500)).toBe("2.5s");
    expect(formatDuration(65_000)).toBe("1m5s");
    expect(formatDuration(3_720_000)).toBe("1h2m");
  });
});
