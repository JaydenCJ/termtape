import { describe, expect, it } from "vitest";

import { renderTerminalText } from "../src/ansi.js";

describe("renderTerminalText", () => {
  it("passes plain text through", () => {
    expect(renderTerminalText("hello world")).toBe("hello world");
  });

  it("handles CRLF line endings", () => {
    expect(renderTerminalText("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("strips SGR color sequences", () => {
    expect(renderTerminalText("\x1b[1;31mred\x1b[0m plain")).toBe("red plain");
  });

  it("strips cursor and erase CSI sequences", () => {
    expect(renderTerminalText("abc\x1b[2Kdef\x1b[1A\x1b[10;20Hghi")).toBe("abcdefghi");
  });

  it("collapses carriage-return progress bars to their final state", () => {
    const input = "downloading:  10%\rdownloading:  55%\rdownloading: 100%\ndone";
    expect(renderTerminalText(input)).toBe("downloading: 100%\ndone");
  });

  it("keeps trailing characters of an overwritten longer line", () => {
    // \r only moves the cursor; shorter rewrites do not erase the rest.
    expect(renderTerminalText("1234567890\rab")).toBe("ab34567890");
  });

  it("applies backspace edits", () => {
    expect(renderTerminalText("cat\b\b\bdog")).toBe("dog");
    expect(renderTerminalText("ab\bc")).toBe("ac");
  });

  it("expands tabs to 8-column stops", () => {
    expect(renderTerminalText("a\tb")).toBe("a       b");
    expect(renderTerminalText("12345678\tx")).toBe("12345678        x");
  });

  it("strips OSC sequences terminated by BEL and by ST", () => {
    expect(renderTerminalText("\x1b]0;window title\x07visible")).toBe("visible");
    expect(renderTerminalText("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });

  it("strips DCS/APC sequences", () => {
    expect(renderTerminalText("\x1bPsome dcs stuff\x1b\\after")).toBe("after");
    expect(renderTerminalText("\x1b_apc payload\x1b\\after")).toBe("after");
  });

  it("strips two-character escapes including charset selection", () => {
    expect(renderTerminalText("\x1b(Bhello\x1b7there\x1b8")).toBe("hellothere");
  });

  it("drops other C0 control characters", () => {
    expect(renderTerminalText("a\x00b\x01c\x7fd")).toBe("abcd");
  });

  it("removes trailing whitespace per line", () => {
    expect(renderTerminalText("abc   \ndef\t")).toBe("abc\ndef");
  });

  it("renders a realistic npm-style spinner sequence", () => {
    const input =
      "\x1b[?25l" + // hide cursor
      "⠙ installing\r" +
      "⠹ installing\r" +
      "\x1b[2K✔ installed 12 packages\n" +
      "\x1b[?25h";
    expect(renderTerminalText(input)).toBe("✔ installed 12 packages\n");
  });

  it("handles unicode content", () => {
    expect(renderTerminalText("日本語 テスト → ✓")).toBe("日本語 テスト → ✓");
  });
});
