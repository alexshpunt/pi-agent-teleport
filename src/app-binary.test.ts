import { expect, test } from "vitest";
import { resolveAppCli, type AppBinaryHost } from "./app-binary.ts";

function host(overrides: Partial<AppBinaryHost> & { files?: string[]; outputs?: Record<string, string> }): AppBinaryHost & { calls: string[] } {
  const calls: string[] = [];
  const files = new Set(overrides.files ?? []);
  return {
    platform: "linux", env: {}, wsl: false, home: () => "/home/user",
    isExecutable: (file) => files.has(file),
    run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      const out = overrides.outputs?.[`${command} ${args.join(" ")}`];
      if (out === undefined) throw new Error(`cannot run ${command}`);
      return out;
    },
    ...overrides, calls,
  };
}

const LOCAL = String.raw`C:\Users\someone\AppData\Local`;
const GET_LOCAL = ["-NoProfile", "-NonInteractive", "-Command", '[Environment]::GetFolderPath("LocalApplicationData")'].join(" ");

test("an explicit path wins, then PI_HERDR_APP_CLI, then the app's own HERDR_APP_BIN", () => {
  const files = ["/usr/bin/herdr-app"];
  const env = { PATH: "/usr/bin", PI_HERDR_APP_CLI: "/pi/app", HERDR_APP_BIN: "/bin/app" };
  expect(resolveAppCli("/explicit/app", host({ env, files }))).toBe("/explicit/app");
  expect(resolveAppCli(undefined, host({ env, files }))).toBe("/pi/app");
  expect(resolveAppCli(undefined, host({ env: { PATH: "/usr/bin", HERDR_APP_BIN: "/bin/app" }, files }))).toBe("/bin/app");
});

test("finds herdr-app on PATH and falls back to the plain name when nothing is installed", () => {
  expect(resolveAppCli(undefined, host({ env: { PATH: "/a:/b" }, files: ["/b/herdr-app"] }))).toBe("/b/herdr-app");
  const none = host({ env: { PATH: "/a:/b" } });
  expect(resolveAppCli(undefined, none)).toBe("herdr-app");
  expect(none.calls).toEqual([]);
});

test("WSL accepts the Windows executable on PATH", () => {
  const found = host({ wsl: true, env: { PATH: "/usr/bin:/mnt/c/Tools" }, files: ["/mnt/c/Tools/herdr-app.exe"] });
  expect(resolveAppCli(undefined, found)).toBe("/mnt/c/Tools/herdr-app.exe");
});

test("WSL asks Windows where the app is installed and translates the path", () => {
  const exe = "/mnt/c/Users/someone/AppData/Local/Programs/herdr-app/herdr-app.exe";
  const found = host({
    wsl: true, env: { PATH: "/usr/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0" },
    files: ["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", exe],
    outputs: {
      [`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ${GET_LOCAL}`]: `${LOCAL}\r\n`,
      [`wslpath -u ${LOCAL}\\Programs\\herdr-app\\herdr-app.exe`]: `${exe}\n`,
    },
  });
  expect(resolveAppCli(undefined, found)).toBe(exe);
});

test("WSL without Windows on PATH finds PowerShell through wslpath, wherever Windows is mounted", () => {
  const powershell = "/windows/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const exe = "/windows/Users/someone/AppData/Local/Programs/herdr-app/herdr-app.exe";
  const found = host({
    wsl: true, env: { PATH: "/usr/bin" }, files: [powershell, exe],
    outputs: {
      [`wslpath -u C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`]: `${powershell}\n`,
      [`${powershell} ${GET_LOCAL}`]: `${LOCAL}\r\n`,
      [`wslpath -u ${LOCAL}\\Programs\\herdr-app\\herdr-app.exe`]: `${exe}\n`,
    },
  });
  expect(resolveAppCli(undefined, found)).toBe(exe);
});

test("WSL without interop or without the app keeps the plain name", () => {
  expect(resolveAppCli(undefined, host({ wsl: true, env: { PATH: "/usr/bin" } }))).toBe("herdr-app");
  const noApp = host({ wsl: true, env: { PATH: "/p" }, files: ["/p/powershell.exe"], outputs: { [`/p/powershell.exe ${GET_LOCAL}`]: `${LOCAL}\r\n`, [`wslpath -u ${LOCAL}\\Programs\\herdr-app\\herdr-app.exe`]: "/missing/herdr-app.exe\n" } });
  expect(resolveAppCli(undefined, noApp)).toBe("herdr-app");
});

test("Windows uses PATH, then the per-user install folder", () => {
  const installed = `${LOCAL}\\Programs\\herdr-app\\herdr-app.exe`;
  expect(resolveAppCli(undefined, host({ platform: "win32", env: { PATH: String.raw`C:\a;C:\tools`, LOCALAPPDATA: LOCAL }, files: [String.raw`C:\tools\herdr-app.exe`] }))).toBe(String.raw`C:\tools\herdr-app.exe`);
  expect(resolveAppCli(undefined, host({ platform: "win32", env: { PATH: String.raw`C:\a`, LOCALAPPDATA: LOCAL }, files: [installed] }))).toBe(installed);
  expect(resolveAppCli(undefined, host({ platform: "win32", env: { PATH: String.raw`C:\a` }, home: () => String.raw`C:\Users\someone`, files: [installed] }))).toBe(installed);
  expect(resolveAppCli(undefined, host({ platform: "win32", env: {} }))).toBe("herdr-app.exe");
});
