/**
 * termtape marker protocol.
 *
 * Shell integration (bash/zsh hooks) emits private OSC escape sequences that
 * segment the raw pty byte stream into individual commands:
 *
 *   ESC ] 7770 ; pre ; <base64 command> ; <base64 cwd> BEL
 *   ESC ] 7770 ; post ; <exit code> BEL
 *
 * OSC number 7770 is unassigned; terminals ignore OSC sequences they do not
 * understand, so even if a marker leaks through to the terminal it renders as
 * nothing. The recorder strips markers from the stream it forwards to the
 * user's terminal anyway.
 */

export const OSC_MARKER_PREFIX = "\x1b]7770;";
export const BEL = "\x07";
export const ST = "\x1b\\";

export type Marker =
  | { type: "pre"; command: string; cwd: string }
  | { type: "post"; exitCode: number | null };

function b64encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function b64decode(value: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Encode a "command is about to run" marker. */
export function encodePreMarker(command: string, cwd: string): string {
  return `${OSC_MARKER_PREFIX}pre;${b64encode(command)};${b64encode(cwd)}${BEL}`;
}

/** Encode a "command finished" marker. */
export function encodePostMarker(exitCode: number | null): string {
  return `${OSC_MARKER_PREFIX}post;${exitCode ?? ""}${BEL}`;
}

/**
 * Decode the payload of an OSC 7770 sequence (the part between
 * `ESC ]7770;` and the terminator). Returns null for malformed payloads.
 */
export function decodeMarkerPayload(payload: string): Marker | null {
  const sep = payload.indexOf(";");
  const kind = sep === -1 ? payload : payload.slice(0, sep);
  const rest = sep === -1 ? "" : payload.slice(sep + 1);

  if (kind === "pre") {
    const parts = rest.split(";");
    if (parts.length < 2) return null;
    const command = b64decode(parts[0] ?? "");
    const cwd = b64decode(parts[1] ?? "");
    if (command === null || cwd === null) return null;
    return { type: "pre", command, cwd };
  }

  if (kind === "post") {
    const trimmed = rest.trim();
    if (trimmed === "") return { type: "post", exitCode: null };
    const code = Number.parseInt(trimmed, 10);
    if (Number.isNaN(code)) return { type: "post", exitCode: null };
    return { type: "post", exitCode: code };
  }

  return null;
}
