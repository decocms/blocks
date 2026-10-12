import { describe, expect, it } from "vitest";
import {
  CIPHERTEXT,
  ciphertextWithLengths,
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
  it.each([
    ["a 2048-bit wrapped key", 256, 12, 16],
    ["a 3072-bit wrapped key", 384, 12, 32],
    ["a 4096-bit wrapped key", 512, 12, 1024],
  ])("accepts %s", (_label, key, iv, ciphertext) => {
    expect(isWellFormedCiphertext(ciphertextWithLengths(key, iv, ciphertext))).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["the bare version", "v1."],
    ["plain text behind the version prefix", "v1.hunter2"],
    ["an API key behind the version prefix", "v1.my-api-key_123"],
    ["two short segments", "v1.QUJD.ZGVm"],
    ["another version", CIPHERTEXT.replace(/^v1/, "v2")],
    ["a wrapped key of the wrong length", ciphertextWithLengths(255, 12, 16)],
    ["an iv of the wrong length", ciphertextWithLengths(384, 16, 32)],
    ["a ciphertext shorter than the GCM tag", ciphertextWithLengths(384, 12, 15)],
    ["a fourth segment", `${CIPHERTEXT}.QUJD`],
    ["padding", `${CIPHERTEXT}==`],
    ["a standard-base64 character", CIPHERTEXT.replace(/.$/, "+")],
    ["a space", CIPHERTEXT.replace(".", ". ")],
    ["plain text", "hunter2"],
    ["a number", 42],
    ["null", null],
  ])("refuses %s", (_label, c) => {
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

  it("leaves a legacy secret loader block's encrypted string alone", () => {
    const loader = "website/loaders/secret.ts";
    const meta = {
      manifest: {
        blocks: {
          ...schemaFixture.manifest?.blocks,
          loaders: { [loader]: { $ref: "#/definitions/djc=" } },
        },
      },
      schema: {
        definitions: {
          ...schemaFixture.schema?.definitions,
          "djc=": {
            type: "object",
            properties: {
              name: { type: "string" },
              encrypted: { type: "string", format: "secret" },
            },
          },
        },
      },
    };
    const entry = {
      __resolveType: "settings",
      apps: { __resolveType: loader, name: "API_KEY", encrypted: "0a1b2c" },
    };
    expect(rules(entry, meta)).toEqual([]);
    expect(rules({ __resolveType: loader, encrypted: secretBlock("bad") }, meta)).toEqual([
      "secret-ciphertext@/encrypted",
    ]);
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
