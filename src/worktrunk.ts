import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** Resolve an existing Worktrunk branch, path, or basename without creating resources. */
export function resolveWorktrunkTarget(cwd: string, target: string): string {
  const output = execFileSync("wt", ["--config-set", "list.json-schema=2", "list", "--format=json"], { cwd, encoding: "utf8" });
  const parsed = JSON.parse(output) as { schema?: number; items?: Array<{ branch?: string | null; worktree?: { path?: string } }> };
  if (parsed.schema !== 2 || !Array.isArray(parsed.items)) throw new Error("Unexpected Worktrunk list output.");
  const matches = parsed.items.filter((item) => item.worktree?.path && (item.branch === target || item.worktree.path === target || item.worktree.path.split("/").at(-1) === target));
  const paths = [...new Set(matches.map((item) => realpathSync(item.worktree!.path!)))];
  if (paths.length !== 1) throw new Error(paths.length ? `Worktrunk target is ambiguous: ${target}` : `Worktrunk target not found: ${target}`);
  return paths[0];
}
