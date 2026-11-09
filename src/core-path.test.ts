import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test.skipIf(process.platform === "win32")("a remote non-login process can find hc in the user's local bin", () => {
  const home = mkdtempSync(join(tmpdir(), "teleport-core-path-"));
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "hc");
  writeFileSync(executable, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
  chmodSync(executable, 0o755);
  const module = resolve("src/herdr.ts");
  const script = `import {runCore} from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(runCore({session:"test",paneId:"",workspaceId:"",tabId:""},["status"])));`;
  try {
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ ok: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
