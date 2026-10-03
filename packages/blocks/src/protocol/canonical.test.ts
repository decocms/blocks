// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  APPLY_DIGEST_DOMAIN,
  applyRequestDigest,
  CanonicalJsonError,
  canonicalJson,
  sha256Hex,
} from "./canonical";

describe("canonicalJson", () => {
  it("sorts object keys recursively in code-unit order and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1,2]},"b":1}',
    );
    // Code-unit order: uppercase before lowercase, numeric-looking keys as strings.
    expect(canonicalJson({ b: 1, B: 2, 10: 3, 9: 4 })).toBe('{"10":3,"9":4,"B":2,"b":1}');
    // An astral character (surrogate pair) sorts by its code units.
    expect(canonicalJson({ "\u{1F600}": 1, "￿": 2 })).toBe('{"\u{1F600}":1,"￿":2}');
  });

  it("is compact with JSON string escaping and number encoding", () => {
    expect(canonicalJson({ s: 'a"\n\u0001', n: 1.5e21, f: 0.1, t: true })).toBe(
      '{"f":0.1,"n":1.5e+21,"s":"a\\"\\n\\u0001","t":true}',
    );
  });

  it("normalizes negative zero to zero", () => {
    expect(canonicalJson({ z: -0 })).toBe('{"z":0}');
  });

  it("gives identical content identical bytes, whatever the insertion order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it.each([
    ["undefined", { a: undefined }],
    ["a function", { a: () => 1 }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", [Number.POSITIVE_INFINITY]],
    ["a bigint", { a: BigInt(1) }],
    ["a symbol", { a: Symbol("x") }],
    ["a Date", { a: new Date(0) }],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it("rejects cycles but accepts shared references", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);
  });

  it("keeps an own __proto__ key", () => {
    expect(canonicalJson(JSON.parse('{"__proto__":{"a":1}}'))).toBe('{"__proto__":{"a":1}}');
  });
});

describe("hashing", () => {
  it("computes SHA-256 hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("binds a request digest to every parameter, with a domain prefix", async () => {
    const a = await applyRequestDigest({ set: { x: { v: 1 } }, requestKey: "k" });
    expect(a).toBe(await applyRequestDigest({ requestKey: "k", set: { x: { v: 1 } } }));
    expect(a).not.toBe(await applyRequestDigest({ set: { x: { v: 2 } }, requestKey: "k" }));
    expect(a).toBe(await sha256Hex(`${APPLY_DIGEST_DOMAIN}{"requestKey":"k","set":{"x":{"v":1}}}`));
  });
});
