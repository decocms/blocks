// @vitest-environment node
/**
 * A hash bug here fails silently: every visitor still gets an answer, it is
 * just the wrong one, and the test's result is quietly meaningless. So the
 * bucketing is pinned twice over — `murmur3_32` against MurmurHash3's own
 * published vectors, and `roll` against a table generated from this
 * implementation. A change to either table is a breaking change for every
 * visitor already allocated, never a test to update.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { murmur3_32, newId, roll } from "./bucketing.ts";
import {
  assign,
  newVisitor,
  parseVisitor,
  readVisitor,
  serializeVisitor,
  type Visitor,
} from "./experiments.ts";

const COOKIE = "deco_vid";

const utf8 = (text: string) => new TextEncoder().encode(text);

/** A visitor with this id. */
const visitor = (id: string): Visitor => ({ id });

/** A `deco_segment` value v7 (or v8 before 8.18) wrote: base64 of URI-encoded JSON. */
const segmentValue = (body: Record<string, unknown>) =>
  btoa(encodeURIComponent(JSON.stringify(body)));

const requestWith = (cookie?: string, url = "https://example.com/") =>
  new Request(url, cookie === undefined ? {} : { headers: { cookie } });

/** A deterministic `RandomBytes`, so a drawn id is reproducible in a test. */
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) {
      state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
      bytes[i] = state & 0xff;
    }
  };
}

/** `count` distinct ids, the same ones on every run. */
function ids(count: number): string[] {
  const random = seededRandom(1);
  return Array.from({ length: count }, () => newId(random));
}

describe("murmur3_32", () => {
  // MurmurHash3 x86 32-bit, seed 0: the algorithm's own published vectors.
  it.each([
    ["", 0x00000000],
    ["a", 0x3c2569b2],
    ["abc", 0xb3dd93fa],
    ["hello", 0x248bfa47],
    ["The quick brown fox jumps over the lazy dog", 0x2e4ff723],
  ])("hashes %j", (input, expected) => {
    expect(murmur3_32(utf8(input))).toBe(expected);
  });

  it("hashes the UTF-8 bytes, not the code units", () => {
    // Computed with an independent implementation of the reference C code
    // over the UTF-8 bytes 61 c3 a7 c3 a3 6f; the low bytes of the UTF-16
    // code units (61 e7 e3 6f) hash to 0xfd40194d instead.
    expect(murmur3_32(utf8("ação"))).toBe(0xf3b0a92b);
    expect(murmur3_32(new Uint8Array([0x61, 0xe7, 0xe3, 0x6f]))).toBe(0xfd40194d);
  });
});

describe("roll", () => {
  // Generated from this implementation. Identical in Node, workerd and a
  // browser: `Math.imul` and `TextEncoder` are the only primitives involved.
  it.each([
    ["pdp-cta", "AAAAAAAAAAAAAAAAAAAAAA", 84.57],
    ["pdp-cta", "f1d2d2f924e986ac86fdf7", 22.34],
    ["pdp-cta", "Zm9vYmFyYmF6cXV4MTIzNA", 42.5],
    ["pdp-cta", "0123456789abcdefghijkl", 83.39],
    ["pdp-cta", "__--__--__--__--__--__", 11.38],
    ["hero-copy", "AAAAAAAAAAAAAAAAAAAAAA", 97.85],
    ["hero-copy", "f1d2d2f924e986ac86fdf7", 13.35],
    ["hero-copy", "Zm9vYmFyYmF6cXV4MTIzNA", 0.93],
    ["hero-copy", "0123456789abcdefghijkl", 64.45],
    ["hero-copy", "__--__--__--__--__--__", 14.9],
    ["free-ship", "AAAAAAAAAAAAAAAAAAAAAA", 17.78],
    ["free-ship", "f1d2d2f924e986ac86fdf7", 35.87],
    ["free-ship", "Zm9vYmFyYmF6cXV4MTIzNA", 9.62],
    ["free-ship", "0123456789abcdefghijkl", 27.13],
    ["free-ship", "__--__--__--__--__--__", 66.2],
    ["name@2", "AAAAAAAAAAAAAAAAAAAAAA", 27.58],
    ["name@2", "f1d2d2f924e986ac86fdf7", 44.6],
    ["name@2", "Zm9vYmFyYmF6cXV4MTIzNA", 45.99],
    ["name@2", "0123456789abcdefghijkl", 12.89],
    ["name@2", "__--__--__--__--__--__", 35.04],
  ])("%s / %s", (name, id, expected) => {
    expect(roll(name, id)).toBe(expected);
  });

  it("lands in [0, 100) with a step of 0.01", () => {
    for (const id of ids(2000)) {
      const value = roll("pdp-cta", id);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(100);
      // A value of the form n/100: `80.4 * 100` is not 8040 in binary floats.
      expect(value).toBe(Math.round(value * 100) / 100);
    }
  });
});

describe("the properties a test's result depends on", { timeout: 60_000 }, () => {
  const population = ids(100_000);
  const inAt = (name: string, allocation: number) =>
    population.filter((id) => roll(name, id) < allocation);

  it("splits 10% within ±0.5%", () => {
    expect(inAt("pdp-cta", 10).length / population.length).toBeCloseTo(0.1, 2);
  });

  it("ramping only adds people: the 10% set is inside the 20% set", () => {
    const wider = new Set(inAt("pdp-cta", 20));
    expect(inAt("pdp-cta", 10).every((id) => wider.has(id))).toBe(true);
  });

  it("keeps two experiments independent", () => {
    const inFirst = inAt("pdp-cta", 50);
    const inBoth = inFirst.filter((id) => roll("hero-copy", id) < 50).length;
    expect(inBoth / inFirst.length).toBeCloseTo(0.5, 2);
  });

  it("re-rolls everyone when a test is restarted under a new name", () => {
    const before = new Set(inAt("hero-copy", 50));
    const after = inAt("hero-copy@2", 50);
    const kept = after.filter((id) => before.has(id)).length / after.length;
    expect(kept).toBeCloseTo(0.5, 2); // a coin flip, not the old split
  });
});

describe("assign", () => {
  it("answers from the id, so the same visitor always gets the same answer", () => {
    for (const id of ids(200)) {
      expect(assign({ "pdp-cta": 50 }, visitor(id))).toEqual(
        assign({ "pdp-cta": 50 }, visitor(id)),
      );
    }
  });

  it("is in when the roll is under the percentage", () => {
    const id = "Zm9vYmFyYmF6cXV4MTIzNA"; // hero-copy rolls 0.93
    expect(assign({ "hero-copy": 1 }, visitor(id))["hero-copy"]).toBe(true);
    expect(assign({ "hero-copy": 0 }, visitor(id))["hero-copy"]).toBe(false);
  });

  it("rounds a fractional percentage and compares the roll with the rounded value", () => {
    const id = "Zm9vYmFyYmF6cXV4MTIzNA"; // hero-copy rolls 0.93
    expect(assign({ "hero-copy": 0.5 }, visitor(id))["hero-copy"]).toBe(true); // 1%
    expect(assign({ "hero-copy": 0.4 }, visitor(id))["hero-copy"]).toBe(false); // 0%
  });

  it("puts nobody in a paused test and everybody in a full one", () => {
    for (const id of ids(500)) {
      expect(assign({ x: 0 }, visitor(id)).x).toBe(false);
      expect(assign({ x: 100 }, visitor(id)).x).toBe(true);
    }
  });

  it("raising a percentage only adds people, whatever path it took", () => {
    for (const id of ids(2000)) {
      const path = [10, 20, 5, 50].map((pct) => assign({ t: pct }, visitor(id)).t);
      if (path[2]) expect(path[0] && path[1] && path[3], id).toBe(true);
      if (path[0]) expect(path[1] && path[3], id).toBe(true);
    }
  });

  it("answers every test false without a visitor, or with one without a usable id", () => {
    for (const none of [null, undefined, { ...visitor("too-short") }]) {
      expect({ ...assign({ a: 100, b: 50 }, none as Visitor | null) }).toEqual({
        a: false,
        b: false,
      });
    }
  });

  it("ignores anything a caller adds to the visitor beyond its id (v7's lists included)", () => {
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    const withLists = { id, active: ["t"], inactiveDrawn: ["u"], pct: { t: 50, u: 50 } };
    expect({ ...assign({ t: 50, u: 50 }, withLists as Visitor) }).toEqual({
      ...assign({ t: 50, u: 50 }, { id }),
    });
    expect({ ...assign({ t: 0 }, { id: "", active: ["t"] } as Visitor) }).toEqual({ t: false });
  });

  it("answers only the tests in the block, and leaves out a percentage that is not a finite number", () => {
    const experiments = { ok: 50, bad: Number.NaN, worse: "50" } as unknown as Record<
      string,
      number
    >;
    expect(Object.keys(assign(experiments, newVisitor()))).toEqual(["ok"]);
  });

  it("treats __proto__ as an ordinary name", () => {
    const experiments = JSON.parse('{"__proto__": 100}') as Record<string, number>;
    const answers = assign(experiments, newVisitor());
    expect(Object.keys(answers)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(answers, "__proto__")?.value).toBe(true);
  });

  it("never throws, whatever it is handed", () => {
    const junk = [
      undefined,
      null,
      {},
      { a: Number.POSITIVE_INFINITY },
      { "": 50 },
      { a: -10 },
      { a: 1e9 },
    ] as unknown as Record<string, number>[];
    const visitors = [null, newVisitor(), { id: 5 }, { id: "AAAAAAAAAAAAAAAAAAAAAA", pct: null }];
    for (const experiments of junk) {
      for (const v of visitors) {
        expect(() => assign(experiments, v as Visitor)).not.toThrow();
      }
    }
  });
});

describe("the visitor's stored form", () => {
  it("is the id itself, and round-trips", () => {
    const v = newVisitor();
    expect(serializeVisitor(v)).toBe(v.id);
    expect(parseVisitor(serializeVisitor(v))).toEqual(v);
  });

  it("parses to null when missing, broken, hostile, or not an id (never throws)", () => {
    const junk = [
      undefined,
      null,
      "",
      "too-short",
      "AAAAAAAAAAAAAAAAAAAAA!",
      "AAAAAAAAAAAAAAAAAAAAAAA", // 23 characters
      "%E0%A4%A", // broken percent-encoding
      "../../etc/passwd",
      // v7's deco_segment format, even one carrying an id, is not a visitor.
      segmentValue({ id: "AAAAAAAAAAAAAAAAAAAAAA", active: [], inactiveDrawn: [], pct: {} }),
    ];
    for (const text of junk) {
      expect(() => parseVisitor(text)).not.toThrow();
      expect(parseVisitor(text), String(text)).toBeNull();
    }
  });

  it("reads a percent-encoded or padded value, as some cookie APIs leave it", () => {
    const v = newVisitor();
    expect(parseVisitor(encodeURIComponent(v.id))?.id).toBe(v.id);
    expect(parseVisitor(`  ${v.id} `)?.id).toBe(v.id);
  });

  it("newVisitor draws a fresh 22-character id each time, and nothing else", () => {
    const a = newVisitor();
    const b = newVisitor();
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.id).not.toBe(b.id);
    expect(Object.keys(a)).toEqual(["id"]);
  });
});

describe("readVisitor", () => {
  it("reads the visitor from the request's cookie, and sends no cookie back", () => {
    const v = newVisitor();
    const { visitor: read, cookie } = readVisitor(
      requestWith(`x=1; ${COOKIE}=${serializeVisitor(v)}; y=2`),
    );
    expect(read.id).toBe(v.id);
    expect(cookie).toBeNull();
  });

  it("makes a visitor on a first visit, with the cookie line to send", () => {
    const { visitor: read, cookie } = readVisitor(requestWith());
    expect(read.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(cookie).toBe(
      `${COOKIE}=${serializeVisitor(read)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    expect(cookie).not.toContain("HttpOnly");
    expect(cookie).not.toContain("Domain");
  });

  it("drops Secure for a request over plain http (localhost)", () => {
    expect(readVisitor(requestWith(undefined, "http://localhost:3000/")).cookie).not.toContain(
      "Secure",
    );
    expect(readVisitor({ headers: new Headers() }).cookie).toContain("Secure");
  });

  it("ignores deco_segment: a visitor with only it gets a new id, even one it carried", () => {
    const carried = "AAAAAAAAAAAAAAAAAAAAAA";
    const old = segmentValue({ id: carried, active: ["pdp-cta"], inactiveDrawn: [], pct: {} });
    const { visitor: read, cookie } = readVisitor(requestWith(`deco_segment=${old}`));
    expect(read.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(read.id).not.toBe(carried);
    expect(Object.keys(read)).toEqual(["id"]);
    expect(cookie?.startsWith(`${COOKIE}=${read.id};`)).toBe(true);
    expect(cookie).not.toContain("deco_segment");
  });

  it("reads deco_vid when deco_segment is there too", () => {
    const v = newVisitor();
    const { visitor: read, cookie } = readVisitor(
      requestWith(`deco_segment=${segmentValue({ active: ["x"] })}; ${COOKIE}=${v.id}`),
    );
    expect(read).toEqual(v);
    expect(cookie).toBeNull();
  });

  it("never throws, and replaces a broken or forged value", () => {
    for (const raw of ["=;;;===", `${COOKIE}=`, `${COOKIE}=garbage!!`]) {
      const { visitor: read, cookie } = readVisitor(requestWith(raw));
      expect(read.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(cookie).not.toBeNull();
    }
    const broken = {
      headers: {
        get: () => {
          throw new Error("no headers");
        },
      },
    };
    expect(() => readVisitor(broken)).not.toThrow();
  });
});

describe("the ./experiments subpath", () => {
  it("package.json maps it to the source and the build", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    expect(pkg.exports["./experiments"]).toEqual({
      types: "./dist/v8/experiments.d.ts",
      source: "./src/v8/experiments.ts",
      default: "./dist/v8/experiments.js",
    });
  });

  it("exports exactly the documented runtime names", async () => {
    expect(Object.keys(await import("./experiments.ts")).sort()).toEqual([
      "assign",
      "newVisitor",
      "parseVisitor",
      "readVisitor",
      "serializeVisitor",
    ]);
  });
});
