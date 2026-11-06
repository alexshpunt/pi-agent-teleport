import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appSpaces, runApp } from "../src/app.ts";
import { readState } from "../src/core.ts";
import { coreEnvironment, guardedLaunch, herdrLocation, isHerdrShell, readHerdrPane, runCore, runHerdr, type HerdrContext } from "../src/herdr.ts";
import { shellQuote, sshOptions } from "../src/remote.ts";

async function until<T>(observe: () => T | undefined, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = observe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("The native two-host fixture did not reach its expected state.");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

test.runIf(process.env.PI_TEST_APP_ROUNDTRIP === "1")("a native Pi session visits the laptop and returns through its authenticated App controller", async () => {
  const laptopRoot = process.env.PI_TEST_LAPTOP_ROOT!;
  const laptopSource = process.env.PI_TEST_LAPTOP_SOURCE!;
  if (!process.env.HERDR_APP_HOME?.includes("lpt1201-adapter") || !laptopRoot.includes("/.tmp/twohost-")) throw new Error("Use only the owned two-host fixture.");
  const host = "mesh-zinlaptop-wsl";
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "teleport-app-roundtrip-")));
  const sourceCwd = join(directory, "source");
  const agentDir = join(directory, "agent");
  const remoteCwd = join(laptopRoot, "destination");
  const root = join(dirname(import.meta.filename), "..");
  for (const path of [sourceCwd, agentDir]) mkdirSync(path);
  const marker = `roundtrip-result:${directory}`;
  const settings = (source: string) => ({
    extensions: [join(source, "src", "index.ts"), join(source, "test", "fixtures", "native-app-roundtrip-provider.ts")],
    defaultProvider: "native-roundtrip", defaultModel: "roundtrip", quietStartup: true,
  });
  const ssh = (code: string) => JSON.parse(execFileSync("ssh", [...sshOptions, host,
    `node --experimental-strip-types --input-type=module -e ${shellQuote(code)}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 65_000 }).trim());
  const remotePreamble = `import * as fs from "node:fs"; const root=${JSON.stringify(laptopRoot)}, agent=root+"/agent";`;
  const remoteInfo = () => ssh(remotePreamble + `
    const file=agent+"/started-remote.json";
    if (!fs.existsSync(file)) console.log("null");
    else { const info=JSON.parse(fs.readFileSync(file,"utf8"));
      info.nativeCwd=fs.readlinkSync("/proc/"+info.pid+"/cwd");
      info.nativeExecutable=fs.readlinkSync("/proc/"+info.pid+"/exe");
      info.nativeArgv=fs.readFileSync("/proc/"+info.pid+"/cmdline","utf8").split("\\0").filter(Boolean);
      const state=agent+"/teleport/"+info.sessionId+"/state.json";
      if (!fs.existsSync(state)) console.log("null");
      else {info.state=JSON.parse(fs.readFileSync(state,"utf8")); console.log(JSON.stringify(info.state.returnRoute ? info : null));}
    }`);
  const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const connection: HerdrContext = {
    backend: "app", workspaceId: "", tabId: "", paneId: "", session: process.env.HC_SESSION!,
    stateHome: process.env.XDG_STATE_HOME, configHome: process.env.XDG_CONFIG_HOME,
    runtimeDir: process.env.XDG_RUNTIME_DIR, appHome: process.env.HERDR_APP_HOME, appCli: process.env.PI_HERDR_APP_CLI,
  };
  const spaces = new Set<string>();
  let source: HerdrContext | undefined;
  let stateDir: string | undefined;
  let remote: any;
  let machineAdded = false;
  const controllers = () => readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number).filter((pid) => {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const action = argv.indexOf(join(root, "src", "bridge.ts"));
      return stateDir && action >= 0 && argv[action + 1] === "controller" && argv[action + 2]?.startsWith(stateDir + "/bridges/")
        && readlinkSync(`/proc/${pid}/cwd`) === sourceCwd;
    } catch { return false; }
  });
  try {
    ssh(remotePreamble + `
      for (const name of ["destination","agent","state","config","runtime"]) fs.mkdirSync(root+"/"+name,{recursive:true,mode:0o700});
      fs.mkdirSync(process.env.XDG_RUNTIME_DIR,{recursive:true,mode:0o700});
      if (fs.existsSync(agent+"/started-remote.json")) throw new Error("Do not reuse an earlier fixture.");
      fs.writeFileSync(agent+"/roundtrip.json",JSON.stringify(${JSON.stringify({ actor: "remote", target: "", marker })}));
      fs.writeFileSync(agent+"/settings.json",JSON.stringify(${JSON.stringify(settings(laptopSource))}));
      console.log("true");`);
    writeFileSync(join(agentDir, "roundtrip.json"), JSON.stringify({ actor: "local", target: `ssh://${host}${remoteCwd}`, marker }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings(root)));
    runCore(connection, ["machine", "add", host, "--name", "lpt1201-laptop", "--session", process.env.PI_TEST_LAPTOP_SESSION!]);
    machineAdded = true;
    source = herdrLocation(connection, runHerdr(connection, ["workspace", "create", "--cwd", sourceCwd, "--label", "Round-trip source", "--no-focus"]));
    spaces.add(source.workspaceId);
    await until(() => isHerdrShell(source!, source!.paneId) ? true : undefined);
    const manager = SessionManager.create(sourceCwd, join(agentDir, "sessions"));
    manager.appendCustomEntry("roundtrip-seed", { marker });
    const initialSession = manager.getSessionFile()!;
    writeFileSync(initialSession, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const prompt = `Carry ${marker} through the laptop and back.`;
    const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    runHerdr(source, ["pane", "run", source.paneId, guardedLaunch([process.execPath, cli, "--approve", "--session", initialSession, prompt],
      join(directory, "source-exit.json"), { PI_CODING_AGENT_DIR: agentDir, PATH: process.env.PATH! })]);
    const started = await until(() => existsSync(join(agentDir, "started-source.json")) ? json(join(agentDir, "started-source.json")) : undefined);
    stateDir = join(agentDir, "teleport", started.sessionId);
    const observed = runHerdr(source, ["pane", "process-info", "--pane", source.paneId]).process_info;
    expect(observed.foreground_processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid: started.pid, cwd: sourceCwd })]));
    writeFileSync(join(agentDir, "go-source"), "continue\n");
    remote = await until(() => remoteInfo() ?? undefined);
    expect(remote).toMatchObject({ sessionId: started.sessionId, cwd: remoteCwd, nativeCwd: remoteCwd,
      context: { backend: "app", appMachine: "lpt1201-laptop" } });
    expect(remote.nativeExecutable).toBe(remote.executable);
    expect(remote.entryPoint).toBe(join(laptopSource, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"));
    expect(remote.state.returnRoute.operationId).toBeTruthy();
    await until(() => !existsSync(initialSession) ? true : undefined);
    expect(() => process.kill(started.pid, 0)).toThrow();
    expect(appSpaces(connection).flatMap((space) => space.tabs.flatMap((tab) => tab.terminals)).some((terminal) => terminal.terminal === source!.paneId)).toBe(false);
    // This must still work after the originating Pi died: the controller owns the UI channel.
    const remoteUi = ssh(remotePreamble + `
      const {appSpaces}=await import(${JSON.stringify(join(laptopSource, "src", "app.ts"))});
      const {runHerdr}=await import(${JSON.stringify(join(laptopSource, "src", "herdr.ts"))});
      const info=JSON.parse(fs.readFileSync(agent+"/started-remote.json","utf8"));
      console.log(JSON.stringify({spaces:appSpaces(info.context), process:runHerdr(info.context,["pane","process-info","--pane",info.context.paneId]).process_info}));`);
    expect(remoteUi.spaces.some((space: any) => space.id === remote.context.workspaceId)).toBe(true);
    expect(remoteUi.process.foreground_processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid: remote.pid, cwd: remoteCwd })]));
    ssh(remotePreamble + 'fs.writeFileSync(agent+"/go-remote","continue\\n"); console.log("true");');
    await until(() => existsSync(join(agentDir, "settled-returned.json")) ? true : undefined);
    const returned = json(join(agentDir, "started-returned.json"));
    const settled = json(join(agentDir, "settled-returned.json"));
    const state = readState(stateDir);
    expect(returned).toMatchObject({ sessionId: started.sessionId, cwd: sourceCwd, entryPoint: started.entryPoint });
    expect(returned.pid).not.toBe(started.pid);
    expect(state.pendingRemote).toBeUndefined();
    expect(state.returnRoute).toBeUndefined();
    expect(state.history).toHaveLength(2);
    expect(state.history.map((move) => move.status)).toEqual(["completed", "completed"]);
    expect(state.active).toMatchObject({ cwd: sourceCwd, sessionFile: returned.sessionFile });
    spaces.add(state.active!.herdr!.workspaceId);
    expect(settled.header).toMatchObject({ id: started.sessionId, cwd: sourceCwd });
    const entries = settled.entries as any[];
    expect(entries.filter((entry) => entry.customType === "roundtrip-seed")).toEqual([expect.objectContaining({ data: { marker } })]);
    expect(entries.filter((entry) => entry.customType === "pi-agent-teleport-continuation")).toHaveLength(2);
    expect(entries.filter((entry) => entry.message?.role === "user").some((entry) => entry.message.content.some((part: any) => part.text === prompt))).toBe(true);
    expect(entries.filter((entry) => entry.message?.role === "assistant" && entry.message.content.some((part: any) => part.type === "text"))).toEqual([expect.objectContaining({ message: expect.objectContaining({ content: [{ type: "text", text: marker }] }) })]);
    const nativeReturned = runHerdr(returned.context, ["pane", "process-info", "--pane", returned.context.paneId]).process_info;
    expect(nativeReturned.foreground_processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid: returned.pid, cwd: sourceCwd })]));
    await until(() => ssh(remotePreamble + `
      const info=JSON.parse(fs.readFileSync(agent+"/started-remote.json","utf8"));
      let alive=true; try {process.kill(info.pid,0);} catch(e) {if(e.code==="ESRCH") alive=false; else throw e;}
      console.log(JSON.stringify(!alive&&!fs.existsSync(info.sessionFile)));`) ? true : undefined);
    await until(() => controllers().length === 0 ? true : undefined);
    if (process.env.PI_TEST_APP_SHOT) {
      runApp(returned.context, ["do", "agent.focus", JSON.stringify({ terminal: returned.context.paneId })]);
      execFileSync(returned.context.appCli, ["shot", process.env.PI_TEST_APP_SHOT], { env: coreEnvironment(returned.context), stdio: "pipe" });
    }
    expect(readHerdrPane(returned.context, returned.context.paneId)).toContain(sourceCwd);
    console.log(JSON.stringify({ nativeRoundtrip: { sessionId: started.sessionId, sourcePid: started.pid, laptopPid: remote.pid, returnedPid: returned.pid,
      sourceCwd, laptopCwd: remoteCwd, history: state.history.length } }));
  } catch (error) {
    const safe = (read: () => unknown) => { try { return read(); } catch (failure) { return String(failure); } };
    throw new Error(JSON.stringify({ error: String(error), localFiles: safe(() => execFileSync("ls", ["-R", agentDir], {encoding:"utf8"})),
      state: stateDir ? safe(() => readState(stateDir!)) : undefined,
      remote: safe(remoteInfo), screen: source ? safe(() => readHerdrPane(source!, source!.paneId)) : undefined }));
  } finally {
    for (const side of ["source", "returned"]) {
      const path = join(agentDir, `started-${side}.json`);
      if (!existsSync(path)) continue;
      const info = json(path);
      try { if (readlinkSync(`/proc/${info.pid}/cwd`) === info.cwd) process.kill(info.pid, "SIGTERM"); }
      catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      await until(() => { try { process.kill(info.pid, 0); return undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } });
    }
    ssh(remotePreamble + `
      const file=agent+"/started-remote.json";
      if(fs.existsSync(file)) {const info=JSON.parse(fs.readFileSync(file,"utf8"));
        try {if(fs.readlinkSync("/proc/"+info.pid+"/cwd")===info.cwd) process.kill(info.pid,"SIGTERM");}
        catch(e) {if(!["ENOENT","ESRCH"].includes(e.code)) throw e;}}
      console.log("true");`);
    if (stateDir) {
      const state = readState(stateDir);
      if (state.active?.herdr && !state.active.herdr.appMachine) spaces.add(state.active.herdr.workspaceId);
    }
    for (const id of spaces) if (appSpaces(connection).some((space) => space.id === id)) runApp(connection, ["do", "space.close", JSON.stringify({ id, confirmed: true })]);
    if (machineAdded) runCore(connection, ["machine", "rm", "lpt1201-laptop"]);
    execFileSync("ssh", [...sshOptions, host, "hc server stop"], { stdio: "pipe", timeout: 15_000 });
    for (const pid of controllers()) process.kill(pid, "SIGTERM");
    await until(() => controllers().length === 0 ? true : undefined);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
