// @vitest-environment node
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { joinPath, rewriteErrors } from "./messages";

const ajv = new Ajv({ allErrors: true, strict: false });
const errors = (schema: object, data: unknown) => {
  const validate = ajv.compile(schema);
  validate(data);
  return rewriteErrors(validate.errors, data);
};

describe("paths", () => {
  it("writes JSON pointers as property paths", () => {
    expect(joinPath("", "/sections/2/title")).toBe("sections[2].title");
    expect(joinPath("page", "/a~1b/c d")).toBe('page["a/b"]["c d"]');
    expect(joinPath("x", "")).toBe("x");
  });
});

describe("plain wording", () => {
  it.each([
    [{ type: "object", required: ["title"] }, {}, "title: required"],
    [{ type: "string", maxLength: 3 }, "abcdef", ": 6 characters, max 3"],
    [{ type: "string", minLength: 3 }, "a", ": 1 characters, min 3"],
    [{ type: "number", maximum: 10 }, 11, ": 11, max 10"],
    [{ type: "number", minimum: 1 }, 0, ": 0, min 1"],
    [{ enum: ["sm", "md"] }, "xl", ': "xl" isn\'t one of "sm", "md"'],
    [{ const: "a" }, "b", ': "b" isn\'t "a"'],
    [{ type: "string" }, 1, ": expected a string, got a number"],
    [{ type: "array", maxItems: 1 }, [1, 2], ": 2 items, max 1"],
    [{ type: "object", properties: {}, additionalProperties: false }, { x: 1 }, "x: unknown field"],
  ])("%j", (schema, data, line) => {
    const [first] = errors(schema, data);
    expect(`${first.path}: ${first.message}`).toBe(line);
  });

  it("keeps the branch that got furthest in a union", () => {
    const schema = {
      type: "object",
      properties: {
        product: {
          anyOf: [
            { type: "object", required: ["__resolveType"] },
            {
              type: "object",
              required: ["name", "price"],
              properties: { name: { type: "string" } },
            },
          ],
        },
      },
    };
    expect(errors(schema, { product: { name: "x" } })).toEqual([
      { path: "product.price", message: "required" },
    ]);
  });

  it("drops a nullable union's null branch when the value isn't null", () => {
    const schema = { anyOf: [{ enum: ["a", "b"] }, { type: "null" }] };
    expect(errors(schema, "c")).toEqual([{ path: "", message: '"c" isn\'t one of "a", "b"' }]);
  });

  it("says so once when no branch explains the failure", () => {
    expect(errors({ anyOf: [{ type: "string" }, { type: "number" }] }, true)).toEqual([
      { path: "", message: "expected a string, got a boolean" },
      { path: "", message: "expected a number, got a boolean" },
    ]);
  });
});
