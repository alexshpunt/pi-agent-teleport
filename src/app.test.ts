import { beforeEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { runHerdr } from "./herdr.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const app = { backend: "app" as const, paneId: "t7", workspaceId: "sp3", tabId: "tb4", session: "owned", appHome: "/owned/app" };
const create = ["tab", "create", "--workspace", "sp3", "--cwd", "/checkout", "--label", "my session", "--no-focus"];
const created = { space: "sp3", tab: "tb5", terminal: "t8" };
function calls() { return vi.mocked(execFileSync).mock.calls.map(([command, args]) => [command, args]); }
function rejected(error: string): never { throw Object.assign(new Error("CLI failed"), { stdout: JSON.stringify({ error }) }); }

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
