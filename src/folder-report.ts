import { hostname } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The OSC 7 sequence that tells the terminal which folder the session is in:
 * `ESC ] 7 ; file://<host>/<path> ESC \`. Terminals such as Herdr show the
 * agent under that folder; the Pi process folder alone is invisible to them
 * on Windows.
 */
export function folderReport(cwd: string, options: { host?: string; windows?: boolean } = {}): string {
  const url = pathToFileURL(cwd, { windows: options.windows ?? process.platform === "win32" });
  // For UNC, identify the reporting machine in the authority rather than the
  // file server. Otherwise the URI is indistinguishable from an SSH report.
  const path = url.host ? `/${encodeURIComponent(fileURLToPath(url, { windows: true }))}` : url.pathname;
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
