/**
 * Golden fixtures for canonical content hashing: every implementation that
 * computes a content revision (the CLI, the release materializer, the site
 * editor's backend) checks it produces these exact bytes and hashes.
 *
 * ```ts
 * import { contentHashFixtures } from "@decocms/blocks/protocol/conformance";
 * for (const f of contentHashFixtures) expect(await myRevision(f.blocks)).toBe(f.revision);
 * ```
 */

export interface ContentHashFixture {
  id: string;
  title: string;
  /** The `blocks` map: entry name to entry. */
  blocks: Record<string, unknown>;
  /** Its canonical JSON. */
  canonical: string;
  /** SHA-256 of the canonical JSON's UTF-8 bytes, lowercase hex. */
  revision: string;
}

export const contentHashFixtures: readonly ContentHashFixture[] = [
  {
    id: "empty",
    title: "an empty map",
    blocks: {},
    canonical: "{}",
    revision: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  },
  {
    id: "key-order",
    title:
      "keys sorted recursively in code-unit order, numeric-looking keys included; arrays keep their order",
    blocks: { b: { z: 1, a: 2 }, a: [3, 1, 2], B: true, "10": "ten", "2": "two", "": null },
    canonical: '{"":null,"10":"ten","2":"two","B":true,"a":[3,1,2],"b":{"a":2,"z":1}}',
    revision: "e10ffc5fe1399986d69ff6a5c326d3eca5a4c6ff4134504d2e169676e1155e52",
  },
  {
    id: "strings",
    title: "JSON string escaping: control characters escaped, non-ASCII and line separators as is",
    blocks: {
      s: {
        text: "Ol\u00e1 \u2014 \u4e16\u754c \ud83d\ude00",
        quote: '"\\/',
        control: "\u0000\u001f\n\t",
        separators: "\u2028\u2029",
      },
    },
    canonical:
      '{"s":{"control":"\\u0000\\u001f\\n\\t","quote":"\\"\\\\/","separators":"\u2028\u2029","text":"Ol\u00e1 \u2014 \u4e16\u754c \ud83d\ude00"}}',
    revision: "3dbb4dd183b625c383b703df94c2d12ae6271cad0ee7e63c51cf1bfda18c799c",
  },
  {
    id: "numbers",
    title: "JSON number encoding, negative zero as zero",
    blocks: {
      n: { zero: -0, int: 42, neg: -7, frac: 0.1, big: 1e21, small: 1e-7, max: 9007199254740991 },
    },
    canonical:
      '{"n":{"big":1e+21,"frac":0.1,"int":42,"max":9007199254740991,"neg":-7,"small":1e-7,"zero":0}}',
    revision: "783d90091668991414259155fb6b37ae5f09afc80a3aea62405fbe515bac535c",
  },
  {
    id: "page",
    title: "a small site",
    blocks: {
      "pages-Home": {
        __resolveType: "page",
        path: "/",
        sections: [{ __resolveType: "hero", title: "Hi" }],
      },
      Header: { __resolveType: "header", links: [] },
    },
    canonical:
      '{"Header":{"__resolveType":"header","links":[]},"pages-Home":{"__resolveType":"page","path":"/","sections":[{"__resolveType":"hero","title":"Hi"}]}}',
    revision: "6913c5e6aa28f441d3b0102177b372e4fb7c08bc09bdd8698df85e597282ac96",
  },
];

export interface BlockVersionFixture {
  id: string;
  /** The block (any JSON value). */
  block: unknown;
  /** Its canonical JSON. */
  canonical: string;
  /** `blockVersion(block)`: the first 16 bytes of SHA-256 over the canonical JSON, base64url, no padding. */
  version: string;
}

/**
 * Golden fixtures for block versions (`blockVersion`, in
 * `@decocms/blocks/protocol`): every implementation that writes or checks
 * `ifMatch` produces these exact versions.
 */
export const blockVersionFixtures: readonly BlockVersionFixture[] = [
  { id: "empty", block: {}, canonical: "{}", version: "RBNvo1WzZ4oRRq0W9-hkng" },
  {
    id: "key-order",
    block: { b: 1, a: [true, null, "x"] },
    canonical: '{"a":[true,null,"x"],"b":1}',
    version: "VKZUFa03AiiFGh2ksxtv1A",
  },
  {
    id: "unicode-numbers",
    block: {
      __resolveType: "site/sections/Hero.tsx",
      title: "Olá — ünïcode 😀",
      n: -0,
      f: 1.5e-7,
      big: 1e21,
      int: 10,
    },
    canonical:
      '{"__resolveType":"site/sections/Hero.tsx","big":1e+21,"f":1.5e-7,"int":10,"n":0,"title":"Olá — ünïcode 😀"}',
    version: "cvNhsZmxtnrgaCwRg73Kxw",
  },
  {
    id: "code-unit-order",
    block: { é: 1, Z: 2, a: 3, aa: 4, "": 0 },
    canonical: '{"":0,"Z":2,"a":3,"aa":4,"é":1}',
    version: "psFj7dEx0yLDzHd3f9mabQ",
  },
  {
    id: "nested-escapes",
    block: { nested: { z: { y: [1, { b: 2, a: 1 }] }, a: 'line\nbreak "q" \\ \u0001' } },
    canonical: '{"nested":{"a":"line\\nbreak \\"q\\" \\\\ \\u0001","z":{"y":[1,{"a":1,"b":2}]}}}',
    version: "-F2yA3CkzEaGhmts3kOA3w",
  },
];

export interface RevisionIdFixture {
  id: string;
  /** Whether it has the shape of a revision id (`isRevisionId`). */
  valid: boolean;
}

/** Revision ids (`<inv>-<uuidv7>`) and strings that aren't one. */
export const revisionIdFixtures: readonly RevisionIdFixture[] = [
  { id: "fe6c5e0d97ff-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a55", valid: true },
  { id: "fe5e5eb831ff-01a1a147-ce00-7000-8000-000000000000", valid: true },
  { id: "fe5e5eb831fe-01a1a147-ce01-7fff-bfff-ffffffffffff", valid: true },
  // A git commit SHA, a content hash, a bare UUIDv7.
  { id: "1".repeat(40), valid: false },
  { id: "f".repeat(64), valid: false },
  { id: "0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a55", valid: false },
  // Uppercase, another UUID version, the wrong variant, a path.
  { id: "FE6C5E0D97FF-0193A1F2-6800-7C3E-9D2A-4B8E1F0C7A55", valid: false },
  { id: "fe6c5e0d97ff-0193a1f2-6800-4c3e-9d2a-4b8e1f0c7a55", valid: false },
  { id: "fe6c5e0d97ff-0193a1f2-6800-7c3e-cd2a-4b8e1f0c7a55", valid: false },
  { id: "fe6c5e0d97ff-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a55/../x", valid: false },
  { id: "", valid: false },
];
