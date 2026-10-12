import { describe, expect, it } from "vitest";
import { ContentProtocolError, ErrorCode } from "./errors";
import { validateParams } from "./params";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as ContentProtocolError).code;
  }
  return undefined;
};

describe("validateParams", () => {
  it("accepts no params or {} for a method without parameters", () => {
    expect(validateParams("describe", undefined)).toEqual({});
    expect(validateParams("describe", {})).toEqual({});
  });

  it("requires params to be an object", () => {
    for (const params of [[], null, "x", 1]) {
      expect(code(() => validateParams("blocks.list", params))).toBe(ErrorCode.InvalidParams);
    }
  });

  it("rejects unknown parameters, naming them", () => {
    expect(() => validateParams("blocks.apply", { set: {}, ifUnmodifiedSince: "x" })).toThrow(
      /ifUnmodifiedSince/,
    );
    expect(code(() => validateParams("describe", { verbose: true }))).toBe(ErrorCode.InvalidParams);
    expect(code(() => validateParams("schema.get", { since: "x" }))).toBe(ErrorCode.InvalidParams);
  });

  it("checks parameter types", () => {
    expect(code(() => validateParams("blocks.apply", { delete: "x" }))).toBe(
      ErrorCode.InvalidParams,
    );
    expect(code(() => validateParams("blocks.apply", { ifMatch: { a: 1 } }))).toBe(
      ErrorCode.InvalidParams,
    );
    expect(code(() => validateParams("blocks.apply", { ifMatch: { a: "" } }))).toBe(
      ErrorCode.InvalidParams,
    );
    expect(code(() => validateParams("blocks.list", { ifNoneMatch: 5 }))).toBe(
      ErrorCode.InvalidParams,
    );
  });

  it("leaves entry shapes to InvalidBlock and returns the raw object", () => {
    const params = JSON.parse('{"set":{"__proto__":{"a":1},"arr":[]},"ifMatch":{"x":null}}');
    const out = validateParams("blocks.apply", params);
    expect(out).toBe(params);
    expect(Object.keys(out.set!)).toEqual(["__proto__", "arr"]);
  });

  it("throws ContentProtocolError", () => {
    expect(() => validateParams("blocks.list", [])).toThrow(ContentProtocolError);
  });
});
