import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

/**
 * The OSC 7 sequence that tells the terminal which folder the session is in:
 * `ESC ] 7 ; file://<host>/<path> ESC \`. Terminals such as Herdr show the
 * agent under that folder; the Pi process folder alone is invisible to them
 * on Windows.
 */
export function folderReport(cwd: string, options: { host?: string; windows?: boolean } = {}): string {
  const url = pathToFileURL(cwd, { windows: options.windows ?? process.platform === "win32" });
  // A UNC share keeps its server as the host.
  const target = url.host ? url.href : `file://${encodeURIComponent(options.host ?? hostname())}${url.pathname}`;
  return `\x1b]7;${target}\x1b\\`;
}

/** An empty OSC 7: the session no longer reports a folder. */
export const clearedFolderReport = "\x1b]7;\x1b\\";

/** Writes a report to the terminal, only from the interactive TUI on a real terminal. */
export function writeFolderReport(mode: string, sequence: string, output: NodeJS.WriteStream = process.stdout): void {
  if (mode === "tui" && output.isTTY) output.write(sequence);
}
