/**
 * StreamParser: splits a raw pty byte stream into "output" events and
 * decoded termtape marker events.
 *
 * The parser is fully incremental — markers may be split across arbitrary
 * chunk boundaries (byte-by-byte delivery is supported). Bytes that could be
 * the beginning of a marker are held back until they can be classified; call
 * flush() at stream end to release anything still buffered.
 */

import { decodeMarkerPayload, type Marker, OSC_MARKER_PREFIX } from "./markers.js";

export type ParserEvent =
  | { type: "output"; data: Buffer }
  | { type: "marker"; marker: Marker };

const PREFIX = Buffer.from(OSC_MARKER_PREFIX, "latin1");
const ESC = 0x1b;
const BEL_BYTE = 0x07;
const BACKSLASH = 0x5c;

/** Safety valve: an unterminated marker longer than this is treated as output. */
const MAX_MARKER_BYTES = 64 * 1024;

export class StreamParser {
  private buf: Buffer = Buffer.alloc(0);
  private inMarker = false;

  /** Feed a chunk; returns the events that became complete. */
  push(chunk: Buffer | string): ParserEvent[] {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
    const events: ParserEvent[] = [];

    for (;;) {
      if (this.inMarker) {
        const term = this.findTerminator();
        if (term === null) {
          if (this.buf.length > MAX_MARKER_BYTES) {
            // Not a real marker (or a hostile one). Re-emit everything raw.
            events.push({
              type: "output",
              data: Buffer.concat([PREFIX, this.buf]),
            });
            this.buf = Buffer.alloc(0);
            this.inMarker = false;
          }
          break;
        }
        const payload = this.buf.subarray(0, term.index).toString("utf8");
        this.buf = this.buf.subarray(term.index + term.length);
        this.inMarker = false;
        const marker = decodeMarkerPayload(payload);
        if (marker) events.push({ type: "marker", marker });
        // Malformed OSC 7770 payloads are silently dropped: they can only be
        // produced by (broken) termtape integration and render as nothing.
        continue;
      }

      const idx = this.buf.indexOf(PREFIX);
      if (idx !== -1) {
        if (idx > 0) {
          events.push({ type: "output", data: this.buf.subarray(0, idx) });
        }
        this.buf = this.buf.subarray(idx + PREFIX.length);
        this.inMarker = true;
        continue;
      }

      // No full prefix. Hold back the longest tail that could still grow
      // into the prefix; emit the rest.
      const hold = this.partialPrefixLength();
      const emit = this.buf.length - hold;
      if (emit > 0) {
        events.push({ type: "output", data: this.buf.subarray(0, emit) });
        this.buf = this.buf.subarray(emit);
      }
      break;
    }

    return events;
  }

  /** Release any buffered bytes as raw output (call at stream end). */
  flush(): ParserEvent[] {
    const events: ParserEvent[] = [];
    if (this.inMarker) {
      events.push({ type: "output", data: Buffer.concat([PREFIX, this.buf]) });
    } else if (this.buf.length > 0) {
      events.push({ type: "output", data: this.buf });
    }
    this.buf = Buffer.alloc(0);
    this.inMarker = false;
    return events;
  }

  /** Find BEL or ESC-\ terminator inside the marker payload buffer. */
  private findTerminator(): { index: number; length: number } | null {
    for (let i = 0; i < this.buf.length; i++) {
      const b = this.buf[i];
      if (b === BEL_BYTE) return { index: i, length: 1 };
      if (b === ESC) {
        if (i + 1 >= this.buf.length) return null; // partial ST; wait
        if (this.buf[i + 1] === BACKSLASH) return { index: i, length: 2 };
      }
    }
    return null;
  }

  /** Length of the buffer tail that is a strict prefix of the marker intro. */
  private partialPrefixLength(): number {
    const max = Math.min(this.buf.length, PREFIX.length - 1);
    for (let k = max; k > 0; k--) {
      let match = true;
      for (let j = 0; j < k; j++) {
        if (this.buf[this.buf.length - k + j] !== PREFIX[j]) {
          match = false;
          break;
        }
      }
      if (match) return k;
    }
    return 0;
  }
}
