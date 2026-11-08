import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { retireAppSource } from "../src/bridge.ts";
import { startAppSourceCleanup } from "../src/remote.ts";
import { runApp, appSpaces } from "../src/app.ts";
import { createManagedWorktree, prepareHerdrDestination, preserveHerdrSourceWorkspace, readState, removeManagedWorktree } from "../src/core.ts";
import { coreEnvironment, getHerdrContext, guardedLaunch, herdrLocation, isHerdrShell, readHerdrPane, runHerdr, type HerdrContext } from "../src/herdr.ts";

async function until<T>(observe: () => T | undefined, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const result = observe();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error("The isolated fixture did not reach its expected state.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test.runIf(process.env.PI_TEST_HERDR_APP === "1")("the real App adapter creates, names, reuses, observes and removes only its owned worktree", async () => {
  if (!process.env.HERDR_APP_HOME?.includes("lpt1201-adapter")) throw new Error("This test requires its task-owned App sandbox.");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "teleport-app-adapter-")));
  const repo = join(directory, "repo"); mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  writeFileSync(join(repo, "README"), "fixture\n"); git("add", "."); git("commit", "-m", "initial");
  const connection: HerdrContext = { backend: "app", workspaceId: "", tabId: "", paneId: "", session: process.env.HC_SESSION!, stateHome: process.env.XDG_STATE_HOME, configHome: process.env.XDG_CONFIG_HOME, runtimeDir: process.env.XDG_RUNTIME_DIR, appHome: process.env.HERDR_APP_HOME, appCli: process.env.PI_HERDR_APP_CLI };
  const spaces = new Set<string>();
  let programPid: number | undefined;
  try {
    const source = herdrLocation(connection, runHerdr(connection, ["workspace", "create", "--cwd", repo, "--label", "Source", "--no-focus"]));
    spaces.add(source.workspaceId);
    await until(() => isHerdrShell(source, source.paneId) ? true : undefined);
    const resolved = getHerdrContext({ ...process.env, HC_TERMINAL_ID: source.paneId });
    expect(resolved).toMatchObject({ backend: "app", workspaceId: source.workspaceId, tabId: source.tabId, paneId: source.paneId });
    runApp(source, ["do", "overlay.close", "{}"]);
    // Creation returns before the window receives core's live-terminal event.
    let focusError: unknown;
    try {
      await until(() => {
        try { runApp(source, ["do", "agent.focus", JSON.stringify({ terminal: source.paneId })]); return true; }
        catch (error) { focusError = error; return undefined; }
      });
    } catch { throw focusError; }
    const selection = () => { const status = runApp(source, ["status"]); return [status.space, status.tab, status.focused_pane]; };
    const before = selection();
    const stateDir = join(directory, "state");
    const resource = createManagedWorktree({ repo, branch: "owned", path: join(directory, "checkout"), stateDir, herdr: source });
    spaces.add(resource.herdr!.workspaceId);
    expect(resource.herdr!.parentWorkspaceId).toBe(source.workspaceId);
    expect(existsSync(join(resource.path, ".git"))).toBe(true);
    if (process.env.PI_TEST_APP_BACKGROUND === "1") expect(selection()).toEqual(before);
    else expect(selection().slice(0, 2)).toEqual([resource.herdr!.workspaceId, resource.herdr!.tabId]);
    await until(() => isHerdrShell(source, resource.herdr!.paneId) ? true : undefined);
    const destination = prepareHerdrDestination(source, resource.path, resource.herdr, "Session name");
    expect(destination.location.paneId).toBe(resource.herdr!.paneId);
    const ownSpace = appSpaces(source).find((space) => space.id === destination.location.workspaceId)!;
    expect(ownSpace.tabs).toHaveLength(1);
    expect(ownSpace.tabs[0].name).toBe("Session name");
    if (process.env.PI_TEST_APP_SHOT) execFileSync(source.appCli!, ["shot", process.env.PI_TEST_APP_SHOT], { env: coreEnvironment(source), stdio: "pipe" });
    const ready = join(directory, "program-ready.json");
    const exited = join(directory, "program-exited.json");
    const program = `require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);`;
    runHerdr(source, ["pane", "run", destination.location.paneId, guardedLaunch([process.execPath, "-e", program], exited)]);
    try { programPid = await until(() => existsSync(ready) ? JSON.parse(readFileSync(ready, "utf8")).pid as number : undefined); }
    catch (error) { throw new Error(`${String(error)}\n${readHerdrPane(source, destination.location.paneId)}\n${existsSync(exited) ? readFileSync(exited, "utf8") : ""}`); }
    let observation: any;
    try {
      await until(() => {
        observation = runHerdr(source, ["pane", "process-info", "--pane", destination.location.paneId]).process_info;
        return observation.foreground_processes.some((entry: { pid: number; cwd?: string }) => entry.pid === programPid && entry.cwd === resource.path) ? true : undefined;
      });
    } catch (error) {
      const probe = (read: () => unknown) => { try { return read(); } catch (failure) { return String(failure); } };
      const proc = (pid: number) => ({
        listed: readdirSync("/proc").includes(String(pid)),
        stat: probe(() => readFileSync(`/proc/${pid}/stat`, "utf8")),
        cwd: probe(() => readlinkSync(`/proc/${pid}/cwd`)),
        argv: probe(() => readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")),
        uid: probe(() => readFileSync(`/proc/${pid}/status`, "utf8").split("\n").filter((line) => /^(Uid|Gid|NSpid|TracerPid):/.test(line))),
        userNamespace: probe(() => readlinkSync(`/proc/${pid}/ns/user`)),
        uidMap: probe(() => readFileSync(`/proc/${pid}/uid_map`, "utf8")),
      });
      throw new Error(JSON.stringify({ error: String(error), expected: { pid: programPid, cwd: resource.path }, observation, program: proc(programPid!), shell: proc(observation.shell_pid), observer: proc(process.pid) }));
    }
    expect(() => removeManagedWorktree({ repo, id: resource.id, stateDir, herdr: source })).toThrow();
    expect(existsSync(resource.path)).toBe(true);
    process.kill(programPid!, "SIGTERM"); programPid = undefined;
    await until(() => isHerdrShell(source, destination.location.paneId) ? true : undefined);
    removeManagedWorktree({ repo, id: resource.id, stateDir, herdr: source });
    expect(existsSync(resource.path)).toBe(false);
    expect(readState(stateDir).resources[resource.id]).toBeUndefined();
    expect(appSpaces(source).some((space) => space.id === destination.location.workspaceId)).toBe(false);
    preserveHerdrSourceWorkspace(source, repo);
    const sourceSession = join(directory, "source-session.jsonl");
    writeFileSync(sourceSession, "owned source transcript");
    rmSync(ready);
    runHerdr(source, ["pane", "run", source.paneId, guardedLaunch([process.execPath, "-e", program], exited)]);
    programPid = await until(() => existsSync(ready) ? JSON.parse(readFileSync(ready, "utf8")).pid as number : undefined);
    // A foreign occupant must survive a stale cleanup request, with its file intact.
    await expect(retireAppSource({ context: source, sourcePid: process.pid, cwd: repo, sessionFile: sourceSession })).rejects.toThrow();
    expect(existsSync(sourceSession)).toBe(true);
    await startAppSourceCleanup({ context: source, sourcePid: programPid, cwd: repo, sessionFile: sourceSession }, stateDir);
    try { await until(() => !existsSync(sourceSession) ? true : undefined); }
    catch (error) {
      const workers = readdirSync(join(stateDir, "cleanup")).map((id) => {
        const dir = join(stateDir, "cleanup", id);
        return { id, log: readFileSync(join(dir, "worker.log"), "utf8"), result: existsSync(join(dir, "result.json")) ? readFileSync(join(dir, "result.json"), "utf8") : undefined };
      });
      throw new Error(JSON.stringify({ error: String(error), workers }));
    }
    programPid = undefined;
    const remaining = appSpaces(source).find((space) => space.id === source.workspaceId)!;
    expect(remaining.tabs).toHaveLength(1);
    expect(remaining.tabs[0].terminals).toHaveLength(1);
    expect(remaining.tabs[0].terminals[0].terminal).not.toBe(source.paneId);
  } finally {
    if (programPid) { try { process.kill(programPid, "SIGKILL"); } catch {} }
    for (const id of spaces) {
      if (appSpaces(connection).some((space) => space.id === id)) runApp(connection, ["do", "space.close", JSON.stringify({ id, confirmed: true })]);
    }
    const worktrees = git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
    for (const path of worktrees.filter((path) => path !== repo)) git("worktree", "remove", "--force", path);
    rmSync(directory, { recursive: true, force: true });
  }
});


test.runIf(process.env.PI_TEST_HERDR_APP === "1")("a real Pi moves between its native App terminals, continues once and retires only its source", async () => {
  if (!process.env.HERDR_APP_HOME?.includes("lpt1201-adapter")) throw new Error("This test requires its task-owned App sandbox.");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "teleport-app-pi-")));
  const sourceCwd = join(directory, "source");
  const target = join(directory, "destination");
  const agentDir = join(directory, "agent");
  for (const path of [sourceCwd, target, agentDir]) mkdirSync(path);
  const root = join(dirname(import.meta.filename), "..");
  writeFileSync(join(agentDir, "native-app.json"), JSON.stringify({ target }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    extensions: [join(root, "src", "index.ts"), join(root, "test", "fixtures", "native-app-provider.ts")],
    defaultProvider: "native-app", defaultModel: "native-app-model", quietStartup: true,
  }));
  const connection: HerdrContext = { backend: "app", workspaceId: "", tabId: "", paneId: "", session: process.env.HC_SESSION!, stateHome: process.env.XDG_STATE_HOME, configHome: process.env.XDG_CONFIG_HOME, runtimeDir: process.env.XDG_RUNTIME_DIR, appHome: process.env.HERDR_APP_HOME, appCli: process.env.PI_HERDR_APP_CLI };
  const spaces = new Set<string>();
  const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const manager = SessionManager.create(sourceCwd, join(agentDir, "sessions"));
  manager.appendCustomEntry("native-app-seed", { sentinel: directory });
  const initialSession = manager.getSessionFile()!;
  writeFileSync(initialSession, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  let source: HerdrContext | undefined;
  let stateDir: string | undefined;
  try {
    source = herdrLocation(connection, runHerdr(connection, ["workspace", "create", "--cwd", sourceCwd, "--label", "Native Pi source", "--no-focus"]));
    spaces.add(source.workspaceId);
    await until(() => isHerdrShell(source!, source!.paneId) ? true : undefined);
    const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    const prompt = `Preserve native conversation ${directory} and move to the destination.`;
    runHerdr(source, ["pane", "run", source.paneId, guardedLaunch([process.execPath, cli, "--approve", "--session", initialSession, prompt], join(directory, "source-exit.json"), { PI_CODING_AGENT_DIR: agentDir })]);
    const started = await until(() => existsSync(join(agentDir, "started-source.json")) ? json(join(agentDir, "started-source.json")) : undefined);
    stateDir = join(agentDir, "teleport", started.sessionId);
    const observed = runHerdr(source, ["pane", "process-info", "--pane", source.paneId]).process_info;
    expect(observed.foreground_processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid: started.pid, cwd: sourceCwd })]));
    expect(started.sessionFile).toBe(initialSession);
    expect(existsSync(initialSession)).toBe(true);
    writeFileSync(join(agentDir, "go"), "continue\n");
    const settledFile = join(agentDir, "settled-destination.json");
    await until(() => existsSync(settledFile) ? true : undefined, 60_000);
    const state = readState(stateDir);
    const arrival = json(join(agentDir, "started-destination.json"));
    const settled = json(settledFile);
    const destination = state.active!.herdr!;
    spaces.add(destination.workspaceId);
    expect(state.transition).toBeUndefined();
    expect(state.active).toMatchObject({ cwd: target, sessionFile: arrival.sessionFile });
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ from: sourceCwd, to: target, status: "completed", fromHerdr: { paneId: source.paneId }, toHerdr: { paneId: destination.paneId } });
    expect(arrival.sessionId).toBe(started.sessionId);
    expect(arrival.pid).not.toBe(started.pid);
    expect(arrival.entryPoint).toBe(started.entryPoint);
    expect(settled.header).toMatchObject({ id: started.sessionId, cwd: target });
    const entries = settled.entries as any[];
    expect(entries.filter((entry) => entry.customType === "native-app-seed")).toEqual([expect.objectContaining({ data: { sentinel: directory } })]);
    expect(entries.filter((entry) => entry.customType === "pi-agent-teleport-continuation")).toHaveLength(1);
    expect(entries.filter((entry) => entry.message?.role === "user").some((entry) => entry.message.content.some((part: any) => part.text === prompt))).toBe(true);
    expect(entries.filter((entry) => entry.message?.role === "assistant" && entry.message.content.some((part: any) => part.type === "text"))).toHaveLength(1);
    const nativeDestination = runHerdr(destination, ["pane", "process-info", "--pane", destination.paneId]).process_info;
    expect(nativeDestination.foreground_processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid: arrival.pid, cwd: target })]));
    await until(() => !existsSync(initialSession) ? true : undefined);
    expect(() => process.kill(started.pid, 0)).toThrow();
    expect(appSpaces(connection).flatMap((space) => space.tabs.flatMap((tab) => tab.terminals)).some((terminal) => terminal.terminal === source!.paneId)).toBe(false);
    const screen = readHerdrPane(destination, destination.paneId);
    expect(screen).toContain(target);
    if (process.env.PI_TEST_APP_SHOT) {
      runApp(destination, ["do", "agent.focus", JSON.stringify({ terminal: destination.paneId })]);
      execFileSync(destination.appCli!, ["shot", process.env.PI_TEST_APP_SHOT.replace(/\.png$/, "-pi.png")], { env: coreEnvironment(destination), stdio: "pipe" });
    }
  } catch (error) {
    const safe = (observe: () => unknown) => { try { return observe(); } catch (failure) { return String(failure); } };
    throw new Error(JSON.stringify({ error: String(error), files: readdirSync(agentDir), state: stateDir ? safe(() => readState(stateDir!)) : undefined,
      sourceScreen: source ? safe(() => readHerdrPane(source!, source!.paneId)) : undefined,
      exit: existsSync(join(directory, "source-exit.json")) ? json(join(directory, "source-exit.json")) : undefined }));
  } finally {
    for (const side of ["source", "destination"]) {
      const file = join(agentDir, `started-${side}.json`);
      if (!existsSync(file)) continue;
      const processInfo = json(file);
      try {
        if (readlinkSync(`/proc/${processInfo.pid}/cwd`) !== processInfo.cwd) continue;
        process.kill(processInfo.pid, "SIGTERM");
      } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      await until(() => { try { process.kill(processInfo.pid, 0); return undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } });
    }
    // Record a partially created destination too, without touching other sandbox spaces.
    if (stateDir) {
      const state = readState(stateDir);
      if (state.active?.herdr) spaces.add(state.active.herdr.workspaceId);
    }
    for (const id of spaces) {
      if (appSpaces(connection).some((space) => space.id === id)) runApp(connection, ["do", "space.close", JSON.stringify({ id, confirmed: true })]);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
