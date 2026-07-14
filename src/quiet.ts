/**
 * Suppress the node:sqlite ExperimentalWarning.
 *
 * This module must be imported before anything that imports node:sqlite
 * (ES module evaluation order guarantees that when it is the first import
 * of store.ts). The feature has been unflagged since Node 22.13; the
 * warning is pure noise for CLI users.
 */

const originalEmitWarning = process.emitWarning.bind(process);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).emitWarning = (warning: unknown, ...args: unknown[]) => {
  const text =
    typeof warning === "string"
      ? warning
      : warning instanceof Error
        ? warning.message
        : "";
  if (text.includes("SQLite is an experimental feature")) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
};

export {};
