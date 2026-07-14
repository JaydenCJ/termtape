import os from "node:os";
import path from "node:path";

/**
 * Database location:
 *   1. $TERMTAPE_DB
 *   2. $XDG_DATA_HOME/termtape/termtape.db
 *   3. ~/.local/share/termtape/termtape.db
 */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TERMTAPE_DB && env.TERMTAPE_DB.trim() !== "") return env.TERMTAPE_DB;
  const dataHome =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== ""
      ? env.XDG_DATA_HOME
      : path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "termtape", "termtape.db");
}

/**
 * Config location:
 *   1. $TERMTAPE_CONFIG
 *   2. $XDG_CONFIG_HOME/termtape/config.json
 *   3. ~/.config/termtape/config.json
 */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TERMTAPE_CONFIG && env.TERMTAPE_CONFIG.trim() !== "") return env.TERMTAPE_CONFIG;
  const cfgHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : path.join(os.homedir(), ".config");
  return path.join(cfgHome, "termtape", "config.json");
}
