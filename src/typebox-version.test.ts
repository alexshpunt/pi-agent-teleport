import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const modules = join(import.meta.dirname, "..", "node_modules");

function readPackage(path: string): { version: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
}

// Pi gives extensions its own typebox at runtime. Tests must build schemas with that same version.
test("tests import the typebox version the dev Pi depends on, from a single copy", () => {
  const pi = join(modules, "@earendil-works", "pi-coding-agent");
  const piTypebox = readPackage(pi).dependencies?.typebox;

  expect(piTypebox).toBeDefined();
  expect(readPackage(join(modules, "typebox")).version).toBe(piTypebox);
  expect(existsSync(join(pi, "node_modules", "typebox"))).toBe(false);
});
