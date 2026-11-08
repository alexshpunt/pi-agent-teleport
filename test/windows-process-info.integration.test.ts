import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test.skipIf(process.env.PI_TEST_WINDOWS_PROCESS !== "1")("observes real native Windows PID, changed cwd, quoted argv and idle shell", () => {
  const powershell = process.platform === "win32" ? "powershell.exe" : "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const nativePath = (path: string) => process.platform === "win32" ? resolve(path) : execFileSync("wslpath", ["-w", resolve(path)], { encoding: "utf8" }).trim();
  const result = JSON.parse(execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    nativePath("test/fixtures/windows-process-observation.ps1"), "-Observer", nativePath("src/process-info.ps1")],
    { encoding: "utf8", windowsHide: true, timeout: 45_000, maxBuffer: 1024 * 1024 }));
  expect(result.busy).toMatchObject({ shell_pid: result.rootPid, shell_owns_foreground: false,
    foreground_processes: expect.arrayContaining([expect.objectContaining({ pid: result.childPid, cwd: result.cwd, argv: result.argv })]) });
  expect(result.argv.slice(-2)).toEqual(["--session", expect.stringContaining("quoted session.jsonl")]);
  expect(result.cwd).toContain("δ");
  expect(result.unknown).toMatchObject({ shell_pid: result.rootPid, shell_owns_foreground: false, foreground_processes: [] });
  expect(result.wow64RootRejected).toBe(true);
  expect(result.external).toMatchObject({ shell_pid: result.rootPid, shell_owns_foreground: true, foreground_processes: [expect.objectContaining({ pid: result.rootPid })] });
  expect(result.idle).toMatchObject({ shell_pid: result.rootPid, shell_owns_foreground: true,
    foreground_processes: [expect.objectContaining({ pid: result.rootPid })] });
  console.log(JSON.stringify({ nativeWindowsObservation: result }));
}, 60_000);
