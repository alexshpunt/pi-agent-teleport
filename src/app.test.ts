import { beforeEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { runHerdr } from "./herdr.ts";
import { appPlacement, assertAppHost, runAppProxy } from "./app.ts";
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

test("a Herdr machine name resolves to its saved SSH target", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ machines: [
    { name: "laptop-wsl", target: "mesh-zinlaptop-wsl", session: null, via: false, temporary: false },
    { name: "vps", target: "mesh-vps", session: null, via: false, temporary: false },
  ] }));
  expect(remoteMachine("laptop-wsl", app)).toEqual({ machine: "laptop-wsl", remoteSession: "default", target: "mesh-zinlaptop-wsl" });
  expect(remoteMachine("mesh-vps", app)).toEqual({ machine: "vps", remoteSession: "default" });
  // Resolving a name needs no SSH call.
  expect(calls().every(([command]) => command === "hc")).toBe(true);
});

test("an unreachable target reports SSH's reason and the usable machines, not the encoded command", () => {
  vi.mocked(execFileSync)
    .mockReturnValueOnce(JSON.stringify({ machines: [
      { name: "laptop-wsl", target: "mesh-zinlaptop-wsl", via: false, temporary: false },
      { name: "sandbox", target: "mesh-sandbox", via: false, temporary: true },
    ] }))
    .mockImplementationOnce(() => { throw Object.assign(new Error("Command failed: ssh -T laptop node -e \"eval(Buffer.from('Y29uc3Q','base64'))\""), { stdout: "", stderr: "ssh: Could not resolve hostname laptop: No such host is known.\r\n" }); });
  let message = "";
  try { remoteMachine("laptop", app); } catch (error) { message = (error as Error).message; }
  expect(message).toBe("Teleport cannot reach laptop: ssh: Could not resolve hostname laptop: No such host is known. Use a Herdr machine name or its SSH target: laptop-wsl (mesh-zinlaptop-wsl). The source has not moved.");
});

test("App routing rejects a window that does not contain the calling terminal", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ spaces: [{ id: "sp3", tabs: [{ id: "tb4", terminals: [{ terminal: "different", pane: "p1" }] }] }] }));
  expect(() => assertAppHost(app)).toThrow();
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ spaces: [{ id: "sp3", tabs: [{ id: "tb4", terminals: [{ terminal: "t7", pane: "p1" }] }] }] }));
  expect(() => assertAppHost(app)).not.toThrow();
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

test("the source placement names its App space and a named tab, not a numbered position", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ spaces: [{ id: "sp3", name: "pi-agent-ide · LPT-1442", machine: null, tabs: [{ id: "tb4", name: "LPT-1442 node-pty", terminals: [{ terminal: "t7", pane: "p1" }] }] }] }));
  expect(appPlacement(app)).toEqual({ space: "pi-agent-ide · LPT-1442", tab: "LPT-1442 node-pty" });
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ spaces: [{ id: "sp3", name: "pi-agent-ide", machine: null, tabs: [{ id: "tb4", name: "2", terminals: [{ terminal: "t7", pane: "p1" }] }] }] }));
  expect(appPlacement(app)).toEqual({ space: "pi-agent-ide" });
});

test("a mirrored space gets its own first tab name", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ space: "worker/sp9", tab: "worker/tb9", terminal: "worker/t9" }));
  runHerdr({ ...app, appMachine: "worker" }, ["workspace", "create", "--cwd", "/checkout", "--label", "space name", "--tab-label", "tab name", "--no-focus"]);
  const [, args] = calls()[0];
  expect(args).toEqual(["do", "space.new", JSON.stringify({ folder: "/checkout", name: "space name", tab: "tab name", machine: "worker", focus: false })]);
});
