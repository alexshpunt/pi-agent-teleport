import { execFileSync } from "node:child_process";
import { expect, test, vi } from "vitest";
import { runHerdr, shellOwnsForeground } from "./herdr.ts";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFileSync: vi.fn() }));

test("Windows observes the native process tree without inventing a Unix foreground group", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const native = { shell_pid: 41, shell_owns_foreground: false,
    foreground_processes: [{ pid: 72, cwd: "C:\\owned space", argv: ["node.exe", "--session", "C:\\owned space\\session.jsonl"] }] };
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.mocked(execFileSync).mockImplementation(((file: string) => {
    if (file === "hc") return JSON.stringify({ address: "t8", pid: 41, state: "live" });
    if (file === "powershell.exe") return JSON.stringify(native);
    throw new Error("Unexpected executable");
  }) as typeof execFileSync);
  try {
    const info = runHerdr({ backend: "app", workspaceId: "sp1", tabId: "tb1", paneId: "t8", session: "owned" }, ["pane", "process-info", "--pane", "t8"]).process_info;
    expect(info).toEqual(native);
    expect(shellOwnsForeground(info)).toBe(false);
    const call = vi.mocked(execFileSync).mock.calls.find(([file]) => file === "powershell.exe")!;
    expect(call[1]).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-File", "41"]));
  } finally {
    Object.defineProperty(process, "platform", platform);
    vi.mocked(execFileSync).mockReset();
  }
});

test.each([
  { shell_pid: 99, shell_owns_foreground: true, foreground_processes: [] },
  { shell_pid: 41, shell_owns_foreground: "true", foreground_processes: [] },
  { shell_pid: 41, shell_owns_foreground: false, foreground_processes: [{ pid: 72, argv: ["pi"] }] },
  { shell_pid: 41, shell_owns_foreground: true, foreground_processes: [] },
])("rejects malformed native process observations: %j", (native) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.mocked(execFileSync).mockImplementation(((file: string) => JSON.stringify(file === "hc" ? { address: "t8", pid: 41, state: "live" } : native)) as typeof execFileSync);
  try {
    expect(() => runHerdr({ backend: "app", workspaceId: "sp1", tabId: "tb1", paneId: "t8", session: "owned" }, ["pane", "process-info", "--pane", "t8"])).toThrow();
  } finally {
    Object.defineProperty(process, "platform", platform);
    vi.mocked(execFileSync).mockReset();
  }
});
test("native Windows idle and busy verdicts override Unix-only group interpretation", () => {
  expect(shellOwnsForeground({ shell_pid: 41, shell_owns_foreground: true } as any)).toBe(true);
  expect(shellOwnsForeground({ shell_pid: 41, foreground_process_group_id: 41, shell_owns_foreground: false } as any)).toBe(false);
});
