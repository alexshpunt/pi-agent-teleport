import { hostname } from "node:os";
import { createConnection } from "node:net";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The OSC 7 sequence that tells the terminal which folder the session is in:
 * `ESC ] 7 ; file://<host>/<path> ESC \`. Terminals such as Herdr show the
 * agent under that folder; the Pi process folder alone is invisible to them
 * on Windows.
 */
export function folderReport(cwd: string, options: { host?: string; windows?: boolean; token?: string } = {}): string {
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
  const token = options.token ? `&herdr-token=${encodeURIComponent(options.token)}` : "";
  return `\x1b]7;${target}?herdr-pid=${process.pid}${token}\x1b\\`;
}

/** Ask the terminal's existing core to identify this process instance. */
export function processToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const socketPath = env.HC_TERMINAL_SOCKET;
  const terminal = env.HC_TERMINAL_ID;
  if (!socketPath || !terminal || (env.HC_SOCKET && env.HC_SOCKET !== socketPath)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.unref();
    let data = "";
    const finish = (token?: string) => { socket.destroy(); resolve(token); };
    socket.setTimeout(1000, () => finish());
    socket.on("error", () => finish());
    socket.once("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "terminal.process", params: { terminal, pid: process.pid } })}\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 8192) return finish();
      const end = data.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(data.slice(0, end));
        const token = response.id === 1 ? response.result?.token : undefined;
        finish(typeof token === "string" && token.length <= 512 && /^[A-Za-z0-9+/_=-]+$/.test(token) ? token : undefined);
      } catch { finish(); }
    });
    socket.on("end", () => finish());
  });
}
/** An empty OSC 7: the session no longer reports a folder. */
export const clearedFolderReport = "\x1b]7;\x1b\\";

/** Writes a report to the terminal, only from the interactive TUI on a real terminal. */
export function writeFolderReport(mode: string, sequence: string, output: NodeJS.WriteStream = process.stdout): void {
  if (mode === "tui" && output.isTTY) output.write(sequence);
}
