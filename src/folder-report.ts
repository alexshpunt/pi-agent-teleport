import { hostname } from "node:os";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The OSC 7 sequence that tells the terminal which folder the session is in:
 * `ESC ] 7 ; file://<host>/<path> ESC \`. Terminals such as Herdr show the
 * agent under that folder; the Pi process folder alone is invisible to them
 * on Windows.
 */
export function folderReport(cwd: string, options: { host?: string; windows?: boolean } = {}): string {
  const windows = options.windows ?? process.platform === "win32";
  const url = pathToFileURL(cwd, { windows });
  // Use the original path to detect UNC: file URLs normalize localhost away.
  // The authority names the reporting machine, not the share server, so an SSH
  // report remains distinguishable from a local UNC folder.
  const unc = windows && /^[\\/]{2}[^\\/]/.test(cwd);
  const normalized = unc ? win32.normalize(cwd) : "";
  const uncPath = /[\\/]$/.test(cwd) ? normalized : normalized.replace(/\\$/, "");
  const path = unc ? `/${encodeURIComponent(uncPath)}` : url.pathname;
  const target = `file://${encodeURIComponent(options.host ?? hostname())}${path}`;
  // The receiver must not bind a replay or an early report to the wrong PID.
  return `\x1b]7;${target}?herdr-pid=${process.pid}\x1b\\`;
}

/** An empty OSC 7: the session no longer reports a folder. */
export const clearedFolderReport = "\x1b]7;\x1b\\";

/** Writes a report to the terminal, only from the interactive TUI on a real terminal. */
export function writeFolderReport(mode: string, sequence: string, output: NodeJS.WriteStream = process.stdout): void {
  if (mode === "tui" && output.isTTY) output.write(sequence);
}
