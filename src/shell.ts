/**
 * Shell integration.
 *
 * `termtape record` wraps your login shell in a pty and injects tiny
 * preexec/precmd hooks that emit OSC 7770 markers (see markers.ts) around
 * every command. The hooks are written to a temporary rc file — nothing in
 * your dotfiles is modified, and your own rc files are still sourced.
 *
 * bash: `--rcfile <shim>` (shim sources ~/.bashrc, then installs a DEBUG
 *       trap as preexec and prepends a PROMPT_COMMAND precmd).
 * zsh:  temporary ZDOTDIR whose .zshenv/.zshrc source the originals and then
 *       register hooks via add-zsh-hook.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ShellIntegration {
  file: string;
  args: string[];
  /** Environment additions for the child shell. */
  env: Record<string, string>;
  /** True when per-command hooks could be installed for this shell. */
  supported: boolean;
  shellName: string;
  cleanup(): void;
}

export function detectShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHELL && env.SHELL.trim() !== "") return env.SHELL;
  return "/bin/bash";
}

export function bashShim(): string {
  return `# termtape shell integration (bash) — auto-generated, temporary
if [ -z "\${TERMTAPE_NO_RC:-}" ] && [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

__termtape_b64() { printf '%s' "$1" | base64 2>/dev/null | tr -d '\\n'; }

__termtape_at_prompt=1

__termtape_preexec() {
  local __termtape_prev=$?
  [ -n "\${COMP_LINE:-}" ] && return $__termtape_prev
  [ "$__termtape_at_prompt" != 1 ] && return $__termtape_prev
  __termtape_at_prompt=0
  local __termtape_cmd
  __termtape_cmd=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null | sed 's/^ *[0-9][0-9]* *//')
  printf '\\033]7770;pre;%s;%s\\007' "$(__termtape_b64 "$__termtape_cmd")" "$(__termtape_b64 "$PWD")"
  return $__termtape_prev
}

__termtape_precmd() {
  local __termtape_ec=$?
  if [ "$__termtape_at_prompt" != 1 ]; then
    printf '\\033]7770;post;%s\\007' "$__termtape_ec"
    __termtape_at_prompt=1
  fi
  return $__termtape_ec
}

trap '__termtape_preexec' DEBUG
# Note: if your bashrc sets PROMPT_COMMAND as a bash-5.1 array, only its
# first element is preserved here.
if [ -z "\${PROMPT_COMMAND:-}" ]; then
  PROMPT_COMMAND='__termtape_precmd'
else
  PROMPT_COMMAND="__termtape_precmd;$PROMPT_COMMAND"
fi
`;
}

export function zshShim(): string {
  return `# termtape shell integration (zsh) — auto-generated, temporary
__termtape_orig="\${TERMTAPE_ORIG_ZDOTDIR:-$HOME}"
if [[ -z "\${TERMTAPE_NO_RC:-}" && -f "$__termtape_orig/.zshrc" ]]; then
  ZDOTDIR="$__termtape_orig" source "$__termtape_orig/.zshrc"
fi
ZDOTDIR="$__termtape_orig"

__termtape_b64() { printf '%s' "$1" | base64 2>/dev/null | tr -d '\\n' }
typeset -g __termtape_pending=0

__termtape_preexec() {
  __termtape_pending=1
  printf '\\033]7770;pre;%s;%s\\007' "$(__termtape_b64 "$1")" "$(__termtape_b64 "$PWD")"
}

__termtape_precmd() {
  local __termtape_ec=$?
  if (( __termtape_pending )); then
    printf '\\033]7770;post;%s\\007' "$__termtape_ec"
    __termtape_pending=0
  fi
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __termtape_preexec
add-zsh-hook precmd __termtape_precmd
`;
}

export function zshEnvShim(): string {
  return `# termtape shell integration (zsh) — auto-generated, temporary
__termtape_orig="\${TERMTAPE_ORIG_ZDOTDIR:-$HOME}"
if [[ -z "\${TERMTAPE_NO_RC:-}" && -f "$__termtape_orig/.zshenv" ]]; then
  ZDOTDIR="$__termtape_orig" source "$__termtape_orig/.zshenv"
fi
`;
}

export function buildShellIntegration(
  shellPath: string,
  options: { sessionId: string; tmpDir?: string },
): ShellIntegration {
  const shellName = path.basename(shellPath);
  const baseEnv: Record<string, string> = { TERMTAPE_SESSION: options.sessionId };

  if (shellName === "bash" || shellName === "sh") {
    const dir = fs.mkdtempSync(path.join(options.tmpDir ?? os.tmpdir(), "termtape-"));
    const rc = path.join(dir, "bashrc");
    fs.writeFileSync(rc, bashShim(), { mode: 0o600 });
    return {
      file: shellPath,
      args: ["--rcfile", rc, "-i"],
      env: baseEnv,
      supported: true,
      shellName,
      cleanup: () => {
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  if (shellName === "zsh") {
    const dir = fs.mkdtempSync(path.join(options.tmpDir ?? os.tmpdir(), "termtape-"));
    fs.writeFileSync(path.join(dir, ".zshrc"), zshShim(), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, ".zshenv"), zshEnvShim(), { mode: 0o600 });
    return {
      file: shellPath,
      args: ["-i"],
      env: {
        ...baseEnv,
        ZDOTDIR: dir,
        TERMTAPE_ORIG_ZDOTDIR: process.env.ZDOTDIR ?? os.homedir(),
      },
      supported: true,
      shellName,
      cleanup: () => {
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  // Unknown shell: run it, but per-command capture is unavailable.
  return {
    file: shellPath,
    args: [],
    env: baseEnv,
    supported: false,
    shellName,
    cleanup: () => {},
  };
}
