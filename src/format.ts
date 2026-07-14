/** Terminal output formatting for the CLI (list/search/show/sessions). */

import { styleText } from "node:util";

import type { CommandRecord, SearchHit, SessionRecord } from "./store.js";
import { formatDuration } from "./time.js";

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function c(style: Parameters<typeof styleText>[0], text: string): string {
  return useColor ? styleText(style, text) : text;
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function exitBadge(exitCode: number | null): string {
  if (exitCode === null) return c("dim", "[?]");
  if (exitCode === 0) return c("green", "[0]");
  return c("red", `[${exitCode}]`);
}

function oneLine(text: string, max = 90): string {
  const flat = text.replaceAll("\n", " ⏎ ");
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function formatCommandLine(cmd: CommandRecord | SearchHit): string {
  const id = c("yellow", `#${cmd.id}`.padStart(6));
  const when = c("dim", formatTimestamp(cmd.startedAt));
  const badge = exitBadge(cmd.exitCode);
  const branch = cmd.gitBranch ? c("magenta", ` (${cmd.gitBranch})`) : "";
  const dir = c("cyan", cmd.cwd);
  return `${id}  ${when}  ${badge}  ${oneLine(cmd.command)}\n        ${dir}${branch}`;
}

export function formatSearchHit(hit: SearchHit): string {
  const head = formatCommandLine(hit);
  const snip = hit.snippet.trim();
  return snip ? `${head}\n        ${c("dim", oneLine(snip, 140))}` : head;
}

export function formatCommandDetail(cmd: CommandRecord): string {
  const lines = [
    `${c("bold", "command")}   ${cmd.command}`,
    `${c("bold", "id")}        #${cmd.id}`,
    `${c("bold", "when")}      ${formatTimestamp(cmd.startedAt)}${
      cmd.durationMs !== null ? `  (took ${formatDuration(cmd.durationMs)})` : ""
    }`,
    `${c("bold", "exit")}      ${cmd.exitCode ?? "unknown"}`,
    `${c("bold", "cwd")}       ${cmd.cwd}`,
  ];
  if (cmd.gitRoot) {
    lines.push(
      `${c("bold", "git")}       ${cmd.gitBranch ?? "(detached)"}${
        cmd.gitCommit ? ` @ ${cmd.gitCommit.slice(0, 12)}` : ""
      }  in ${cmd.gitRoot}`,
    );
  }
  if (cmd.redactions > 0) {
    lines.push(`${c("bold", "redacted")}  ${cmd.redactions} secret(s) scrubbed`);
  }
  if (cmd.truncated) {
    lines.push(
      `${c("bold", "truncated")} yes (${cmd.outputBytes} bytes total produced)`,
    );
  }
  lines.push(c("bold", "output") + (cmd.output.trim() === "" ? "    (empty)" : ""));
  if (cmd.output.trim() !== "") {
    lines.push(c("dim", "─".repeat(60)));
    lines.push(cmd.output);
    lines.push(c("dim", "─".repeat(60)));
  }
  return lines.join("\n");
}

export function formatSession(s: SessionRecord): string {
  const when = c("dim", formatTimestamp(s.startedAt));
  const state = s.endedAt === null ? c("green", "live") : c("dim", "ended");
  return `${c("yellow", s.id.slice(0, 8))}  ${when}  ${state}  ${s.shell} (${s.mode})  ${
    s.commandCount ?? 0
  } cmd(s)  ${s.user}@${s.hostname}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
