import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runHerdr } from "./herdr.ts";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFileSync: vi.fn() }));

test.runIf(process.platform === "linux")("core process observation includes children in the foreground group but not foreign processes", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "teleport-process-")));
  const program = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify({pid:child.pid})); setInterval(()=>{},1000);`;
  const group = spawn(process.execPath, ["-e", program], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const pid = await new Promise<number>((resolve, reject) => {
      let output = "";
      group.once("error", reject);
      group.once("exit", () => reject(new Error("Fixture exited before publishing its child.")));
      group.stdout.on("data", (chunk) => { output += chunk; if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]).pid); });
    });
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ address: "t8", pid: group.pid, state: "live", foreground: { pid: group.pid, cwd, argv: [process.execPath] } }));
    const info = runHerdr({ backend: "app", workspaceId: "sp1", tabId: "tb1", paneId: "t1", session: "isolated" }, ["pane", "process-info", "--pane", "t8"]).process_info;
    expect(info.foreground_processes).toContainEqual(expect.objectContaining({ pid, cwd }));
    expect(info.foreground_processes.some((entry: { pid: number }) => entry.pid === process.pid)).toBe(false);
  } finally {
    const exited = new Promise((resolve) => group.once("exit", resolve));
    if (group.pid) { try { process.kill(-group.pid, "SIGKILL"); } catch {} }
    if (group.exitCode === null && group.signalCode === null) await exited;
    rmSync(cwd, { recursive: true, force: true });
  }
});
