/**
 * Git context resolution — pure filesystem reads, no `git` subprocess.
 *
 * Called once per recorded command (with the command's cwd from the pre
 * marker), so it must be cheap: it walks up from cwd looking for a `.git`
 * entry and parses HEAD / refs / packed-refs directly. Worktrees and
 * `.git`-file layouts are supported.
 */

import fs from "node:fs";
import path from "node:path";

export interface GitContext {
  /** Repository root (the directory containing `.git`). */
  root: string;
  /** Branch name, or null when HEAD is detached. */
  branch: string | null;
  /** Full commit sha of HEAD, when resolvable. */
  commit: string | null;
}

function readFileTrim(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

function resolveGitDir(dotGit: string): string | null {
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    if (st.isFile()) {
      // Worktree / submodule layout: `.git` is a file "gitdir: <path>".
      const content = readFileTrim(dotGit);
      if (content?.startsWith("gitdir:")) {
        const target = content.slice("gitdir:".length).trim();
        return path.resolve(path.dirname(dotGit), target);
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/** Directory holding refs/ and packed-refs (main .git for worktrees). */
function refsBase(gitDir: string): string {
  const commondir = readFileTrim(path.join(gitDir, "commondir"));
  if (commondir) return path.resolve(gitDir, commondir);
  return gitDir;
}

function resolveRef(gitDir: string, ref: string): string | null {
  const base = refsBase(gitDir);
  const loose = readFileTrim(path.join(base, ref));
  if (loose && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(loose)) return loose;
  const packed = readFileTrim(path.join(base, "packed-refs"));
  if (packed) {
    for (const line of packed.split("\n")) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const sp = line.indexOf(" ");
      if (sp === -1) continue;
      if (line.slice(sp + 1).trim() === ref) return line.slice(0, sp);
    }
  }
  return null;
}

/**
 * Resolve git context for a working directory. Returns null when cwd is not
 * inside a git repository (or on any filesystem error — this function never
 * throws).
 */
export function resolveGitContext(cwd: string): GitContext | null {
  try {
    let dir = path.resolve(cwd);
    for (;;) {
      const gitDir = resolveGitDir(path.join(dir, ".git"));
      if (gitDir) {
        const head = readFileTrim(path.join(gitDir, "HEAD"));
        if (!head) return { root: dir, branch: null, commit: null };
        if (head.startsWith("ref:")) {
          const ref = head.slice("ref:".length).trim();
          const branch = ref.startsWith("refs/heads/")
            ? ref.slice("refs/heads/".length)
            : ref;
          return { root: dir, branch, commit: resolveRef(gitDir, ref) };
        }
        if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) {
          return { root: dir, branch: null, commit: head };
        }
        return { root: dir, branch: null, commit: null };
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}
