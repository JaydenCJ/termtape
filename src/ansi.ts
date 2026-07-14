/**
 * Terminal-text reconstruction.
 *
 * Raw pty output is full of escape sequences, carriage-return tricks
 * (progress bars, spinners) and backspace edits. Storing it verbatim would
 * pollute full-text search, so termtape renders the byte stream into the
 * plain text a user would actually see at the end:
 *
 *  - CSI / OSC / DCS and other escape sequences are stripped
 *  - `\r` returns to column 0 and subsequent text overwrites the line
 *    (progress bars collapse to their final state)
 *  - `\b` moves the cursor left (backspace edits are applied)
 *  - `\t` advances to the next 8-column tab stop
 *  - other C0 control characters are dropped
 *
 * Cursor-movement CSI sequences (arrow keys, cursor addressing) are stripped
 * rather than emulated — termtape is a flight recorder, not a full terminal
 * emulator, and this trade-off keeps line-oriented output (the overwhelming
 * majority of what a shell produces) perfectly faithful.
 */

const ESC = "\x1b";

export function renderTerminalText(input: string): string {
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;

  const put = (ch: string): void => {
    const line = lines[row]!;
    for (let k = line.length; k < col; k++) line[k] = " ";
    line[col] = ch;
    col++;
  };

  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;

    if (ch === ESC) {
      const next = input[i + 1];
      if (next === "[") {
        // CSI: parameters/intermediates until a final byte in 0x40–0x7E.
        let j = i + 2;
        while (j < n) {
          const c = input.charCodeAt(j);
          if (c >= 0x40 && c <= 0x7e) break;
          j++;
        }
        i = j + 1;
        continue;
      }
      if (next === "]") {
        // OSC: until BEL or ST (ESC \).
        let j = i + 2;
        while (j < n) {
          if (input[j] === "\x07") {
            j += 1;
            break;
          }
          if (input[j] === ESC && input[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }
      if (next === "P" || next === "X" || next === "^" || next === "_") {
        // DCS / SOS / PM / APC: until ST.
        let j = i + 2;
        while (j < n && !(input[j] === ESC && input[j + 1] === "\\")) j++;
        i = j + 2;
        continue;
      }
      // Two-character escape (e.g. ESC M, ESC 7, charset selection ESC ( B).
      if (next === "(" || next === ")" || next === "#") {
        i += 3;
      } else {
        i += 2;
      }
      continue;
    }

    if (ch === "\n") {
      lines.push([]);
      row = lines.length - 1;
      col = 0;
      i++;
      continue;
    }
    if (ch === "\r") {
      col = 0;
      i++;
      continue;
    }
    if (ch === "\b") {
      if (col > 0) col--;
      i++;
      continue;
    }
    if (ch === "\t") {
      const target = (Math.floor(col / 8) + 1) * 8;
      const line = lines[row]!;
      while (col < target) {
        if (line[col] === undefined) line[col] = " ";
        col++;
      }
      i++;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      i++;
      continue;
    }

    put(ch);
    i++;
  }

  return lines
    .map((line) => {
      let s = "";
      for (let k = 0; k < line.length; k++) s += line[k] ?? " ";
      // Trailing whitespace carries no information and bloats the DB.
      return s.replace(/[ \t]+$/, "");
    })
    .join("\n");
}
