import { beforeEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { runHerdr } from "./herdr.ts";
import { discoverWslAppDesktop, runAppProxy } from "./app.ts";
import { remoteMachine } from "./remote.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const app = { backend: "app" as const, paneId: "t7", workspaceId: "sp3", tabId: "tb4", session: "owned", appHome: "/owned/app" };
const create = ["tab", "create", "--workspace", "sp3", "--cwd", "/checkout", "--label", "my session", "--no-focus"];
const created = { space: "sp3", tab: "tb5", terminal: "t8" };
function calls() { return vi.mocked(execFileSync).mock.calls.map(([command, args]) => [command, args]); }
function rejected(error: string): never { throw Object.assign(new Error("CLI failed"), { stdout: JSON.stringify({ error }) }); }

test("a manually started remote App agent uses its explicit desktop SSH route", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ space: "worker/sp3", tab: "worker/tb5", terminal: "worker/t8" }));
  const result = runHerdr({ ...app, appMachine: "worker", appSsh: { target: "desktop-ssh", session: "desktop-session" } }, create);
  expect(result.root_pane).toEqual({ pane_id: "t8", tab_id: "tb5", workspace_id: "sp3" });
  const [command, args] = calls()[0];
  expect(command).toBe("ssh");
  expect(args).toContain("desktop-ssh");
  expect(args).toContain("StrictHostKeyChecking=yes");
  expect(args).toContain("ForwardAgent=no");
});

test("App machine discovery consumes native profile names and sessions, not legacy IDs or enabled flags", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ machines: [
    { id: "core-host-identity", name: "worker", target: "worker-ssh", session: "remote-session", via: false },
  ] }));
  expect(remoteMachine("worker-ssh", app)).toEqual({ machine: "worker", remoteSession: "remote-session" });
  expect(calls()).toEqual([["hc", ["machine", "ls", "--json"]]]);
});

test("a WSL App session identifies its Windows desktop from its exact workspace, tab and terminal", () => {
  vi.mocked(execFileSync)
    .mockReturnValueOnce(JSON.stringify({ machines: [] }))
    .mockReturnValueOnce(JSON.stringify({ spaces: [{ machine: "wsl", id: "wsl/sp3", tabs: [{ id: "wsl/tb4", terminals: [{ terminal: "wsl/t7", pane: "wsl/pane" }] }] }] }));
  const result = remoteMachine("desktop-ssh", app);
  expect(result).toMatchObject({ machine: "", remoteSession: "default", desktop: true, sourceContext: { appMachine: "wsl", appSsh: { target: "desktop-ssh" } } });
});

test("a desktop cannot claim a source with a mismatched terminal", () => {
  vi.mocked(execFileSync)
    .mockReturnValueOnce(JSON.stringify({ machines: [] }))
    .mockReturnValueOnce(JSON.stringify({ spaces: [{ machine: "wsl", id: "wsl/sp3", tabs: [{ id: "wsl/tb4", terminals: [{ terminal: "wsl/t8", pane: "wsl/pane" }] }] }] }));
  expect(() => remoteMachine("desktop-ssh", app)).toThrow();
});

test("a WSL App terminal routes its local move to the Windows window's matching WSL machine", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ spaces: [{ machine: "laptop-wsl", id: "laptop-wsl/sp3", tabs: [{ id: "laptop-wsl/tb4", terminals: [{ terminal: "laptop-wsl/t7", pane: "laptop-wsl/pane" }] }] }] }));
  const context = discoverWslAppDesktop(app, "/mnt/c/Herdr/herdr-app.exe");
  expect(context).toMatchObject({ appMachine: "laptop-wsl", appCli: "/mnt/c/Herdr/herdr-app.exe", appWindowsInterop: true });
  const options = vi.mocked(execFileSync).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
  expect(options.env.HC_SOCKET).toBeUndefined();
  expect(options.env.HC_TERMINAL_SOCKET).toBeUndefined();
});

test("WSL routing refuses a window whose terminal does not match the source", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ spaces: [{ machine: "other", id: "other/sp3", tabs: [{ id: "other/tb4", terminals: [{ terminal: "other/t8", pane: "other/pane" }] }] }] }));
  expect(discoverWslAppDesktop(app, "/mnt/c/Herdr/herdr-app.exe")).toBeUndefined();
});

test("the authenticated App proxy permits only UI commands addressed to its remote machine", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ ok: true }));
  const own = ["do", "tab.rename", JSON.stringify({ id: "worker/tb4", name: "session" })];
  expect(runAppProxy(app, "worker", own)).toEqual({ ok: true });
  expect(calls()).toEqual([["herdr-app", own]]);
  vi.mocked(execFileSync).mockClear();
  for (const args of [
    ["do", "tab.rename", JSON.stringify({ id: "tb4", name: "session" })],
    ["do", "tab.close", JSON.stringify({ id: "other/tb4", confirmed: true })],
    ["do", "space.new", JSON.stringify({ machine: "", folder: "/checkout" })],
    ["do", "tab.new", JSON.stringify({ space: "worker/sp3", argv: ["foreign-command"] })],
    ["do", "terminal.kill", JSON.stringify({ terminal: "worker/t7" })],
  ]) expect(() => runAppProxy(app, "worker", args)).toThrow();
  expect(execFileSync).not.toHaveBeenCalled();
});

test("a remote App tab uses its machine-qualified UI handles and returns native core handles", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ space: "worker/sp3", tab: "worker/tb5", terminal: "worker/t8" }));
  const result = runHerdr({ ...app, appMachine: "worker" }, create);
  expect(result.root_pane).toEqual({ pane_id: "t8", tab_id: "tb5", workspace_id: "sp3" });
  const [, args] = calls()[0];
  expect(JSON.parse((args as string[])[2])).toEqual({ space: "worker/sp3", folder: "/checkout", name: "my session", focus: false });
});

test("a remote App workspace is created on its configured machine, never the desktop", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ space: "worker/sp4", tab: "worker/tb6", terminal: "worker/t9" }));
  const result = runHerdr({ ...app, appMachine: "worker" }, ["workspace", "create", "--cwd", "/remote/checkout", "--label", "remote session", "--no-focus"]);
  expect(result.workspace.workspace_id).toBe("sp4");
  const [, args] = calls()[0];
  expect(JSON.parse((args as string[])[2])).toMatchObject({ machine: "worker", folder: "/remote/checkout", focus: false });
});

test("remote App listing cannot confuse colliding desktop or other-machine handles", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ spaces: [
    { id: "sp3", machine: null, tabs: [{ id: "tb4", terminals: [{ terminal: "t7", pane: "p1" }] }] },
    { id: "worker/sp3", machine: "worker", tabs: [{ id: "worker/tb4", terminals: [{ terminal: "worker/t7", pane: "worker/p1" }, { terminal: "worker/t8", pane: "worker/p2" }] }] },
    { id: "other/sp3", machine: "other", tabs: [{ id: "other/tb4", terminals: [{ terminal: "other/t7", pane: "other/p1" }] }] },
  ] }));
  expect(runHerdr({ ...app, appMachine: "worker" }, ["pane", "list", "--workspace", "sp3"]).panes).toEqual([
    { pane_id: "t7", tab_id: "tb4", workspace_id: "sp3" },
    { pane_id: "t8", tab_id: "tb4", workspace_id: "sp3" },
  ]);
});

test("a remote App creation cannot adopt another machine's handles", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ space: "other/sp3", tab: "other/tb5", terminal: "other/t8" }));
  expect(() => runHerdr({ ...app, appMachine: "worker" }, create)).toThrow();
});

test("App creates a named background tab through the public window API", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify(created));
  const result = runHerdr(app, create);
  expect(result.root_pane).toEqual({ pane_id: "t8", tab_id: "tb5", workspace_id: "sp3" });
  expect(calls()).toEqual([["herdr-app", ["do", "tab.new", JSON.stringify({ space: "sp3", folder: "/checkout", name: "my session", focus: false })]]]);
});

test("ordinary App keeps default focusing after rejecting only the unsupported focus argument", () => {
  vi.mocked(execFileSync).mockImplementationOnce(() => rejected("tab.new: unknown argument(s): focus; valid arguments: name, space, folder, argv, task, mod, props"))
    .mockReturnValueOnce(JSON.stringify(created));
  expect(runHerdr(app, create).root_pane.pane_id).toBe("t8");
  expect(calls()).toEqual([
    ["herdr-app", ["do", "tab.new", JSON.stringify({ space: "sp3", folder: "/checkout", name: "my session", focus: false })]],
    ["herdr-app", ["do", "tab.new", JSON.stringify({ space: "sp3", folder: "/checkout", name: "my session" })]],
  ]);
});

test.each(["the window did not answer", "tab.new: unknown argument(s): folder; valid arguments: name", "no space sp3"])("App does not replay a creation after other errors: %s", (error) => {
  vi.mocked(execFileSync).mockImplementation(() => rejected(error));
  expect(() => runHerdr(app, create)).toThrow();
  expect(vi.mocked(execFileSync).mock.calls.length).toBe(1);
});

test("App does not replay a creation after a lost or malformed reply", () => {
  vi.mocked(execFileSync).mockReturnValue("");
  expect(() => runHerdr(app, create)).toThrow();
  expect(vi.mocked(execFileSync).mock.calls.length).toBe(1);
});

test("App lists only terminals in the addressed local space", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ spaces: [
    { id: "sp3", machine: null, tabs: [{ id: "tb4", terminals: [{ terminal: "t7", pane: "p1" }, { terminal: "t9", pane: "p2" }] }] },
    { id: "remote/sp3", machine: "remote", tabs: [{ id: "remote/tb4", terminals: [{ terminal: "remote/t7", pane: "remote/p1" }] }] },
  ] }));
  expect(runHerdr(app, ["pane", "list", "--workspace", "sp3"]).panes).toEqual([
    { pane_id: "t7", tab_id: "tb4", workspace_id: "sp3" },
    { pane_id: "t9", tab_id: "tb4", workspace_id: "sp3" },
  ]);
});
