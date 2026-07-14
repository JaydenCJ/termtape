/**
 * Pty backend abstraction.
 *
 * Preferred backend is node-pty (a real pseudo-terminal: prompts, colors,
 * TUIs and job control all behave exactly as without termtape). node-pty is
 * an optional dependency — if its native build is unavailable, termtape
 * degrades to a pipe backend that still records commands + output but
 * cannot provide a real tty to the child.
 */

import { spawn as childSpawn } from "node:child_process";

export interface PtyOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export interface PtyProcess {
  backend: "node-pty" | "pipe";
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number | null) => void): void;
}

export async function createPty(
  file: string,
  args: string[],
  options: PtyOptions,
): Promise<PtyProcess> {
  try {
    const mod = await import("node-pty");
    const pty = (mod.default ?? mod) as typeof import("node-pty");
    const proc = pty.spawn(file, args, {
      name: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env as Record<string, string>,
    });
    return {
      backend: "node-pty",
      write: (d) => proc.write(d),
      resize: (c, r) => {
        try {
          proc.resize(Math.max(1, c), Math.max(1, r));
        } catch {
          // resizing a dead pty throws; ignore
        }
      },
      kill: (s) => proc.kill(s),
      onData: (cb) => {
        proc.onData(cb);
      },
      onExit: (cb) => {
        proc.onExit(({ exitCode }) => cb(exitCode));
      },
    };
  } catch {
    return createPipeBackend(file, args, options);
  }
}

function createPipeBackend(file: string, args: string[], options: PtyOptions): PtyProcess {
  const child = childSpawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const dataCbs: ((data: string) => void)[] = [];
  const emit = (buf: Buffer) => {
    const s = buf.toString("utf8");
    for (const cb of dataCbs) cb(s);
  };
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);

  // Spawn failures (e.g. ENOENT) surface as an 'error' event, and 'exit' is
  // not guaranteed to follow — report once through the exit callbacks so the
  // caller can clean up instead of crashing on an unhandled event.
  let exited = false;
  const exitCbs: ((code: number | null) => void)[] = [];
  const fireExit = (code: number | null) => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb(code);
  };
  child.on("exit", (code) => fireExit(code));
  child.on("error", (err) => {
    process.stderr.write(`termtape: failed to start '${file}': ${err.message}\n`);
    fireExit(127);
  });

  return {
    backend: "pipe",
    write: (d) => {
      child.stdin?.write(d);
    },
    resize: () => {
      /* not supported without a tty */
    },
    kill: (s) => {
      child.kill((s as NodeJS.Signals | undefined) ?? "SIGTERM");
    },
    onData: (cb) => {
      dataCbs.push(cb);
    },
    onExit: (cb) => {
      exitCbs.push(cb);
    },
  };
}
