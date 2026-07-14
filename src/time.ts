/**
 * Human time-window parsing for `--since` / `--until` / `prune --older-than`.
 *
 * Accepts:
 *   - relative durations: "45s", "30m", "24h", "7d", "2w"
 *   - ISO dates:          "2026-07-01"
 *   - ISO datetimes:      "2026-07-01T12:30:00" / with timezone
 */

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/** Parse a duration like "24h" into milliseconds. Returns null if invalid. */
export function parseDuration(input: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw])$/.exec(input.trim());
  if (!m) return null;
  const value = Number.parseFloat(m[1]!);
  const unit = UNIT_MS[m[2]!]!;
  return Math.round(value * unit);
}

/**
 * Resolve a point in time (epoch ms) from a relative duration ("in the last
 * X") or an absolute date. Returns null when unparseable.
 */
export function parsePointInTime(input: string, now: number = Date.now()): number | null {
  const dur = parseDuration(input);
  if (dur !== null) return now - dur;
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(trimmed)) {
    const t = Date.parse(trimmed);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
