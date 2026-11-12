import { expect, test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { StringEnum } from "./string-enum.ts";

test("StringEnum serializes as a plain string enum", () => {
  expect(JSON.parse(JSON.stringify(StringEnum(["a", "b"])))).toEqual({ type: "string", enum: ["a", "b"] });
  expect(JSON.parse(JSON.stringify(StringEnum(["a", "b"], { description: "Pick one", default: "a" })))).toEqual({
    type: "string",
    enum: ["a", "b"],
    description: "Pick one",
    default: "a",
  });
});

test("StringEnum validates inside a TypeBox object", () => {
  const schema = Type.Object({ choice: StringEnum(["a", "b"]) });
  expect(Value.Check(schema, { choice: "b" })).toBe(true);
  expect(Value.Check(schema, { choice: "c" })).toBe(false);
});
