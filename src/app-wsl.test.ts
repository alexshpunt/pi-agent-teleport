import { beforeEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { resolveAppCli } from "./app-binary.ts";
import { detectAppMachine, runApp } from "./app.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("./app-binary.ts", async (original) => ({ ...await original<typeof import("./app-binary.ts")>(), runningInWsl: () => true, resolveAppCli: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const app = { backend: "app" as const, paneId: "t7", workspaceId: "sp3", tabId: "tb4", session: "owned", appHome: "/owned/app" };
const exe = "/mnt/c/Users/someone/AppData/Local/Programs/herdr-app/herdr-app.exe";
const missing = () => { throw Object.assign(new Error("spawnSync herdr-app ENOENT"), { code: "ENOENT" }); };
const listing = (...spaces: unknown[]) => JSON.stringify({ spaces });
const wslSpace = (machine: string, terminal = "t7") => ({ machine, id: `${machine}/sp3`, tabs: [{ id: `${machine}/tb4`, terminals: [{ terminal: `${machine}/${terminal}`, pane: `${machine}/p1` }] }] });

test("a program that cannot start is looked up and the same call repeated once", () => {
  vi.mocked(resolveAppCli).mockReturnValue(exe);
  vi.mocked(execFileSync).mockImplementationOnce(missing).mockReturnValueOnce(JSON.stringify({ spaces: [] }));
  expect(runApp(app, ["ls"])).toEqual({ spaces: [] });
  expect(vi.mocked(execFileSync).mock.calls.map(([command, args]) => [command, args])).toEqual([["herdr-app", ["ls"]], [exe, ["ls"]]]);
});

test("a program that is nowhere fails with a message naming PI_HERDR_APP_CLI, without a second call", () => {
  vi.mocked(resolveAppCli).mockReturnValue("herdr-app");
  vi.mocked(execFileSync).mockImplementation(missing);
  expect(() => runApp(app, ["ls"])).toThrow(/PI_HERDR_APP_CLI/);
  expect(vi.mocked(execFileSync).mock.calls.length).toBe(1);
});

test("an error other than a missing program is never looked up or repeated", () => {
  vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); });
  expect(() => runApp(app, ["do", "tab.new", "{}"])).toThrow("timed out");
  expect(resolveAppCli).not.toHaveBeenCalled();
  expect(vi.mocked(execFileSync).mock.calls.length).toBe(1);
});

test("WSL detects the machine that the App lists this terminal under", () => {
  vi.mocked(execFileSync).mockReturnValue(listing({ id: "sp1", machine: null, tabs: [] }, wslSpace("laptop-wsl"), wslSpace("other", "t9")));
  expect(detectAppMachine(app, {})).toBe("laptop-wsl");
});

test("a terminal the desktop itself hosts, or one with an ambiguous or missing match, has no machine", () => {
  vi.mocked(execFileSync).mockReturnValue(listing({ id: "sp3", machine: null, tabs: [{ id: "tb4", terminals: [{ terminal: "t7", pane: "p1" }] }] }, wslSpace("remote")));
  expect(detectAppMachine(app, {})).toBeUndefined();
  vi.mocked(execFileSync).mockReturnValue(listing(wslSpace("a"), wslSpace("b")));
  expect(detectAppMachine(app, {})).toBeUndefined();
  vi.mocked(execFileSync).mockReturnValue(listing(wslSpace("a", "t9")));
  expect(detectAppMachine(app, {})).toBeUndefined();
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error("no App"); });
  expect(detectAppMachine(app, {})).toBeUndefined();
});

test("PI_HERDR_APP_MACHINE overrides the listing and an empty value means the App's own machine", () => {
  expect(detectAppMachine(app, { PI_HERDR_APP_MACHINE: "chosen" })).toBe("chosen");
  expect(detectAppMachine(app, { PI_HERDR_APP_MACHINE: "" })).toBeUndefined();
  expect(execFileSync).not.toHaveBeenCalled();
});

test("saved routes already carry their machine and are never probed", () => {
  expect(detectAppMachine({ ...app, appSsh: { target: "desktop" } }, {})).toBeUndefined();
  expect(execFileSync).not.toHaveBeenCalled();
});
