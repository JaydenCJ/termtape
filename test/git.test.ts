import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveGitContext } from "../src/git.js";

const SHA = "8a1393a83099679cbe4aafa78ce3891563be7c86";
const SHA2 = "1111111111111111111111111111111111111111";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "termtape-git-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeRepo(dir: string, opts: { branch?: string; sha?: string; packed?: boolean } = {}) {
  const branch = opts.branch ?? "main";
  const sha = opts.sha ?? SHA;
  const gitDir = path.join(dir, ".git");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  if (opts.packed) {
    fs.writeFileSync(
      path.join(gitDir, "packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/${branch}\n`,
    );
  } else {
    fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "refs", "heads", branch), sha + "\n");
  }
}

describe("resolveGitContext", () => {
  it("returns null outside a repository", () => {
    expect(resolveGitContext(root)).toBeNull();
  });

  it("resolves branch and commit from loose refs", () => {
    makeRepo(root, { branch: "main" });
    expect(resolveGitContext(root)).toEqual({ root, branch: "main", commit: SHA });
  });

  it("resolves from packed-refs", () => {
    makeRepo(root, { branch: "release/v2", packed: true, sha: SHA2 });
    expect(resolveGitContext(root)).toEqual({ root, branch: "release/v2", commit: SHA2 });
  });

  it("walks up from a nested directory", () => {
    makeRepo(root, { branch: "dev" });
    const nested = path.join(root, "src", "deep", "dir");
    fs.mkdirSync(nested, { recursive: true });
    const ctx = resolveGitContext(nested);
    expect(ctx?.root).toBe(root);
    expect(ctx?.branch).toBe("dev");
  });

  it("handles detached HEAD", () => {
    const gitDir = path.join(root, ".git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), SHA + "\n");
    expect(resolveGitContext(root)).toEqual({ root, branch: null, commit: SHA });
  });

  it("handles .git-file worktree layout with commondir refs", () => {
    // main repo
    const main = path.join(root, "main");
    makeRepo(main, { branch: "main" });
    // worktree metadata inside main/.git/worktrees/wt
    const wtGitDir = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, "HEAD"), "ref: refs/heads/feature-x\n");
    fs.writeFileSync(path.join(wtGitDir, "commondir"), "../..\n");
    fs.mkdirSync(path.join(main, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(main, ".git", "refs", "heads", "feature-x"), SHA2 + "\n");
    // the worktree itself
    const wt = path.join(root, "wt");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGitDir}\n`);
    expect(resolveGitContext(wt)).toEqual({ root: wt, branch: "feature-x", commit: SHA2 });
  });

  it("returns branch with null commit when ref is unresolvable", () => {
    const gitDir = path.join(root, ".git");
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/orphan\n");
    expect(resolveGitContext(root)).toEqual({ root, branch: "orphan", commit: null });
  });

  it("never throws on weird input", () => {
    expect(resolveGitContext("/definitely/not/a/real/path/xyz")).toBeNull();
  });
});
