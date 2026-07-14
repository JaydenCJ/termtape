/**
 * CommandAssembler — pure logic that turns the parser's event stream
 * (markers + raw output bytes) into finished command records.
 *
 * Lifecycle per command:
 *   pre marker  -> open a pending command (command text + cwd + start time)
 *   output      -> accumulate bytes (bounded: head + tail are kept)
 *   post marker -> finalize: render terminal text, redact, resolve git
 *                  context, hand the record to the sink
 *
 * Output arriving while no command is pending (prompts, typed-command echo)
 * is discarded — it belongs to the shell UI, not to any command.
 */

import { renderTerminalText } from "./ansi.js";
import { resolveGitContext, type GitContext } from "./git.js";
import type { Marker } from "./markers.js";
import { Redactor } from "./redact.js";

export interface AssembledCommand {
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  /** Rendered, redacted output text. */
  output: string;
  /** Total raw bytes produced by the command (before truncation). */
  outputBytes: number;
  truncated: boolean;
  redactions: number;
  git: GitContext | null;
}

export interface AssemblerOptions {
  redactor?: Redactor;
  maxOutputBytes?: number;
  /** Commands matching any regex are silently skipped. */
  ignore?: RegExp[];
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable git resolver (tests). */
  resolveGit?: (cwd: string) => GitContext | null;
}

interface Pending {
  command: string;
  cwd: string;
  startedAt: number;
  head: Buffer[];
  headBytes: number;
  tail: Buffer[];
  tailBytes: number;
  totalBytes: number;
}

export class CommandAssembler {
  private readonly redactor: Redactor;
  private readonly maxOutputBytes: number;
  private readonly ignore: RegExp[];
  private readonly now: () => number;
  private readonly resolveGit: (cwd: string) => GitContext | null;
  private readonly sink: (cmd: AssembledCommand) => void;
  private pending: Pending | null = null;
  /** Number of commands skipped due to ignore rules or empty command text. */
  skipped = 0;

  constructor(sink: (cmd: AssembledCommand) => void, options: AssemblerOptions = {}) {
    this.sink = sink;
    this.redactor = options.redactor ?? new Redactor();
    this.maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    this.ignore = options.ignore ?? [];
    this.now = options.now ?? Date.now;
    this.resolveGit = options.resolveGit ?? resolveGitContext;
  }

  handleMarker(marker: Marker): void {
    if (marker.type === "pre") {
      // A pre while a command is pending means we never saw its post
      // (e.g. the shell was killed): close it with an unknown exit code.
      if (this.pending) this.finish(null);
      this.pending = {
        command: marker.command.trim(),
        cwd: marker.cwd,
        startedAt: this.now(),
        head: [],
        headBytes: 0,
        tail: [],
        tailBytes: 0,
        totalBytes: 0,
      };
      return;
    }
    // post
    if (this.pending) this.finish(marker.exitCode);
  }

  handleOutput(data: Buffer): void {
    const p = this.pending;
    if (!p || data.length === 0) return;
    p.totalBytes += data.length;
    const half = Math.max(1, Math.floor(this.maxOutputBytes / 2));

    if (p.headBytes < half) {
      const room = half - p.headBytes;
      const take = data.subarray(0, room);
      p.head.push(take);
      p.headBytes += take.length;
      data = data.subarray(room);
      if (data.length === 0) return;
    }
    // Tail: ring of most recent bytes.
    p.tail.push(data);
    p.tailBytes += data.length;
    while (p.tailBytes > half && p.tail.length > 0) {
      const first = p.tail[0]!;
      const excess = p.tailBytes - half;
      if (first.length <= excess) {
        p.tail.shift();
        p.tailBytes -= first.length;
      } else {
        p.tail[0] = first.subarray(excess);
        p.tailBytes -= excess;
      }
    }
  }

  /** Flush a still-open command (stream ended without a post marker). */
  finalize(): void {
    if (this.pending) this.finish(null);
  }

  private finish(exitCode: number | null): void {
    const p = this.pending!;
    this.pending = null;

    if (p.command === "" || this.ignore.some((re) => re.test(p.command))) {
      this.skipped++;
      return;
    }

    const truncated = p.totalBytes > p.headBytes + p.tailBytes;
    let text: string;
    if (truncated) {
      const headText = renderTerminalText(Buffer.concat(p.head).toString("utf8"));
      const tailText = renderTerminalText(Buffer.concat(p.tail).toString("utf8"));
      const dropped = p.totalBytes - p.headBytes - p.tailBytes;
      text = `${headText}\n… [termtape: ${dropped} bytes of output truncated] …\n${tailText}`;
    } else {
      text = renderTerminalText(
        Buffer.concat([...p.head, ...p.tail]).toString("utf8"),
      );
    }

    const commandRedacted = this.redactor.redact(p.command);
    const outputRedacted = this.redactor.redact(text);

    this.sink({
      command: commandRedacted.text,
      cwd: p.cwd,
      startedAt: p.startedAt,
      endedAt: this.now(),
      exitCode,
      output: outputRedacted.text,
      outputBytes: p.totalBytes,
      truncated,
      redactions: commandRedacted.total + outputRedacted.total,
      git: this.resolveGit(p.cwd),
    });
  }
}
