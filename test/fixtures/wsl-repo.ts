import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Opt in on Windows hosts with this distribution installed.
export const wslDistro = process.platform === "win32" ? process.env.TELEPORT_TEST_WSL_DISTRO : undefined;
export function wslRepo(server = "wsl.localhost") {
  const run = (args: string[]) => execFileSync("wsl.exe", ["--distribution", wslDistro!, "--exec", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const temporary = run(["mktemp", "-d", "/tmp/teleport-wsl-XXXXXX"]);
  const root = `\\\\${server}\\${wslDistro}${temporary.replaceAll("/", "\\")}`;
  const repo = join(root, "repo with spaces");
  const linuxRepo = `${temporary}/repo with spaces`;
  const git = (args: string[], cwd = linuxRepo) => run(["git", "-C", cwd, ...args]);
  mkdirSync(repo);
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README"), "fixture\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  return { root, repo, linuxRepo, git, cleanup: () => run(["rm", "-rf", "--", temporary]) };
}
