import { describe, expect, test } from "vitest";
import { arrivalTools } from "./index.ts";

const visible = [{ name: "bash", exposure: "direct" }];

describe("platform tools on arrival", () => {
  test("enables Linux bash after a Windows handoff", () => {
    expect(arrivalTools("win32", "linux", ["read"], visible, {}, true)).toEqual(["read", "bash"]);
  });
  test("does not enable bash when it was available but disabled at the source", () => {
    expect(arrivalTools("win32", "linux", ["read"], visible, {}, false)).toEqual(["read"]);
  });
  test("respects target defaults and hidden tools", () => {
    expect(arrivalTools("win32", "linux", ["read"], visible, { defaultTools: ["-bash"] }, true)).toEqual(["read"]);
    expect(arrivalTools("win32", "linux", ["read"], visible, { defaultTools: ["read"] }, true)).toEqual(["read"]);
    expect(arrivalTools("win32", "linux", ["read"], [{ name: "bash", exposure: "hidden" }], {}, true)).toEqual(["read"]);
  });
  test("does not change other handoffs or duplicate active tools", () => {
    expect(arrivalTools("linux", "linux", ["read"], visible, {}, true)).toEqual(["read"]);
    expect(arrivalTools("win32", "win32", ["read"], visible, {}, true)).toEqual(["read"]);
    expect(arrivalTools("win32", "linux", ["bash"], visible, {}, true)).toEqual(["bash"]);
  });
});
