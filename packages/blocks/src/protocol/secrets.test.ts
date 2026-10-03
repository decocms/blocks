import { describe, expect, it } from "vitest";
import {
  CIPHERTEXT,
  SECRET_BLOCK,
  SECRET_FIELD,
  schemaFixture,
  secretBlock,
} from "./__tests__/fixtures";
import {
  checkSecrets,
  isSecretBlock,
  isSecretFieldSchema,
  isWellFormedCiphertext,
} from "./secrets";

const rules = (entry: unknown, meta = schemaFixture) =>
  checkSecrets("entry", entry, meta).map((v) => `${v.rule}@${v.pointer}`);

describe("ciphertext format", () => {
  it.each(["v1.QUJD", "v1.QUJD.ZGVm", "v1.AbX3-_x", "v1.YWJj==", "v1.a+b/c"])("accepts %j", (c) => {
    expect(isWellFormedCiphertext(c)).toBe(true);
  });

  it.each([
    "",
    "v1.",
    "v1",
    "v2.QUJD",
    "hunter2",
    "v1.QU JD",
    "v1..QUJD",
    42,
    null,
  ])("refuses %j", (c) => {
    expect(isWellFormedCiphertext(c)).toBe(false);
  });

  it("recognizes secret blocks and Secret fields", () => {
    expect(isSecretBlock(secretBlock())).toBe(true);
    expect(isSecretBlock(secretBlock("plain"))).toBe(false);
    expect(isSecretBlock({ __resolveType: "other", ciphertext: CIPHERTEXT })).toBe(false);
    expect(isSecretFieldSchema({ type: "string", format: "secret" })).toBe(true);
    expect(isSecretFieldSchema({ type: "string", format: "password" })).toBe(false);
  });
});

describe("the secret guard", () => {
  const newsletter = (apiKey: unknown) => ({
    __resolveType: SECRET_BLOCK,
    listId: "l1",
    [SECRET_FIELD]: apiKey,
  });

  it("refuses plain text in a Secret field", () => {
    expect(rules(newsletter("hunter2"))).toEqual([`secret-field@/${SECRET_FIELD}`]);
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["an object", { value: "hunter2" }],
    ["a saved-block reference", { __resolveType: "MyKey" }],
  ])("refuses %s in a Secret field", (_label, value) => {
    expect(rules(newsletter(value))).toEqual([`secret-field@/${SECRET_FIELD}`]);
  });

  it("accepts a secret block with a well-formed ciphertext", () => {
    expect(rules(newsletter(secretBlock()))).toEqual([]);
  });

  it("refuses a secret block with a malformed ciphertext", () => {
    expect(rules(newsletter(secretBlock("hunter2")))).toEqual([
      `secret-ciphertext@/${SECRET_FIELD}`,
    ]);
    expect(rules(newsletter({ __resolveType: "secret" }))).toEqual([
      `secret-ciphertext@/${SECRET_FIELD}`,
    ]);
  });

  it("accepts an absent Secret field", () => {
    expect(rules({ __resolveType: SECRET_BLOCK, listId: "l1" })).toEqual([]);
  });

  it("follows $ref, arrays, anyOf and additionalProperties", () => {
    const entry = {
      __resolveType: "settings",
      integrations: [
        { token: secretBlock(), label: "ok" },
        { token: "plain", label: "leak" },
      ],
      nested: { key: "plain" },
      extra: { a: secretBlock(), b: "plain" },
    };
    expect(rules(entry)).toEqual([
      "secret-field@/integrations/1/token",
      "secret-field@/nested/key",
      "secret-field@/extra/b",
    ]);
  });

  it("checks Secret fields of nested blocks by their own definition", () => {
    const page = {
      __resolveType: "page",
      sections: [
        { __resolveType: SECRET_BLOCK, [SECRET_FIELD]: "plain" },
        { __resolveType: "hero", title: "x" },
      ],
    };
    expect(rules(page)).toEqual([`secret-field@/sections/0/${SECRET_FIELD}`]);
  });

  it("accepts variants whose every value is a secret block", () => {
    const variants = (values: unknown[]) =>
      newsletter({
        __resolveType: "multivariate",
        variants: values.map((value) => ({
          rule: { __resolveType: "always" },
          value: { __resolveType: "lazy", value },
        })),
      });
    expect(rules(variants([secretBlock(), secretBlock()]))).toEqual([]);
    expect(rules(variants([secretBlock(), "plain"]))).toEqual([
      `secret-field@/${SECRET_FIELD}/variants/1/value/value`,
    ]);
    expect(rules(newsletter({ __resolveType: "multivariate" }))).toEqual([
      `secret-field@/${SECRET_FIELD}`,
    ]);
  });

  it("accepts legacy variants that hold plain values only when they're secret blocks", () => {
    const legacy = newsletter({
      __resolveType: "website/flags/multivariate.ts",
      variants: [{ rule: { __resolveType: "always" }, value: "plain" }],
    });
    expect(rules(legacy)).toEqual([`secret-field@/${SECRET_FIELD}/variants/0/value`]);
  });

  it("checks every secret block's ciphertext, whatever its field, even without a schema", () => {
    const entry = { __resolveType: "hero", title: secretBlock("bad"), list: [secretBlock()] };
    expect(rules(entry)).toEqual(["secret-ciphertext@/title"]);
    expect(checkSecrets("e", entry, null).map((v) => v.rule)).toEqual(["secret-ciphertext"]);
    expect(checkSecrets("e", secretBlock("bad"), null).map((v) => v.pointer)).toEqual([""]);
  });

  it("leaves non-secret fields alone", () => {
    expect(rules({ __resolveType: "hero", title: "plain text is fine here" })).toEqual([]);
    expect(rules({ __resolveType: "unknown-type", apiKey: "not a known Secret field" })).toEqual(
      [],
    );
  });

  it("names the entry in every violation", () => {
    const [violation] = checkSecrets("Newsletter", newsletter("x"), schemaFixture);
    expect(violation).toMatchObject({
      name: "Newsletter",
      rule: "secret-field",
      pointer: `/${SECRET_FIELD}`,
    });
  });
});
