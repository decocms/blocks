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

const COOKIE = "deco_segment";

const utf8 = (text: string) => new TextEncoder().encode(text);

/** A visitor with this id and nothing stored. */
const visitor = (id: string): Visitor => ({ id, active: [], inactiveDrawn: [], pct: {} });

/** A `deco_segment` value v7 itself would have written: no id. */
const v7Value = (body: Record<string, unknown>) => btoa(encodeURIComponent(JSON.stringify(body)));

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

  it("without a usable id, keeps the stored decisions and leaves every other test out", () => {
    for (const id of ["", "too-short"]) {
      const stored: Visitor = { id, active: ["in", "zero"], inactiveDrawn: ["out"], pct: {} };
      expect({ ...assign({ in: 50, out: 100, zero: 0, other: 100 }, stored) }).toEqual({
        in: true,
        out: false,
        zero: true,
        other: false,
      });
    }
    // A stored decision whose percentage moved past it is rolled, and there is no roll.
    const moved: Visitor = { id: "", active: ["t"], inactiveDrawn: [], pct: { t: 50 } };
    expect(assign({ t: 20 }, moved).t).toBe(false);
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

describe("the v7 visitor", () => {
  /** A v7 visitor, given an id: what `readVisitor` makes of a v7 cookie. */
  const fromV7 = (body: Record<string, unknown>, id = "AAAAAAAAAAAAAAAAAAAAAA") => {
    const { visitor: read } = readVisitor(requestWith(`${COOKIE}=${v7Value(body)}`));
    return { ...read, id };
  };

  it("keeps the decision v7 made while its percentage still holds", () => {
    // In at 50%, but their own roll is 84.57: re-rolling would throw them out.
    const v = fromV7({ active: ["pdp-cta"], inactiveDrawn: [], pct: { "pdp-cta": 50 } });
    expect(assign({ "pdp-cta": 50 }, v)["pdp-cta"]).toBe(true);
  });

  it("honours a v7 cohort named like a saved block, spaces and comma included", () => {
    const cohort = "Test AB 0,5";
    const v = fromV7({ active: [cohort], inactiveDrawn: [], pct: { [cohort]: 50 } });
    expect(assign({ [cohort]: 50 }, v)[cohort]).toBe(true);
    expect(parseVisitor(serializeVisitor(v))?.active).toEqual([cohort]);
  });

  it("keeps a v7 visitor in when the percentage goes up, roll or no roll", () => {
    const v = fromV7({ active: ["pdp-cta"], inactiveDrawn: [], pct: { "pdp-cta": 50 } });
    expect(assign({ "pdp-cta": 60 }, v)["pdp-cta"]).toBe(true);
  });

  it("keeps a v7 visitor out when the percentage goes down", () => {
    const v = fromV7({ active: [], inactiveDrawn: ["pdp-cta"], pct: { "pdp-cta": 50 } });
    expect(assign({ "pdp-cta": 40 }, v)["pdp-cta"]).toBe(false);
  });

  for (const [label, pct] of [
    ["recorded no percentage for the name", undefined],
    ['recorded -1, v7\'s "any percentage"', -1],
  ] as const) {
    it(`keeps both groups where v7 put them when the cookie ${label}`, () => {
      for (const id of ids(400)) {
        for (const isIn of [true, false]) {
          const v = fromV7(
            {
              active: isIn ? ["t"] : [],
              inactiveDrawn: isIn ? [] : ["t"],
              pct: pct === undefined ? {} : { t: pct },
            },
            id,
          );
          expect(assign({ t: 50 }, v).t, `${id} ${isIn}`).toBe(isIn);
        }
      }
    });
  }
});

describe("the visitor's stored form", () => {
  it("round-trips through v7's encoding", () => {
    const v: Visitor = {
      id: "AAAAAAAAAAAAAAAAAAAAAA",
      active: ["a"],
      inactiveDrawn: ["b"],
      pct: { a: 10, b: 50 },
      exp: { "legacy-nway": "arm-b" },
    };
    expect(parseVisitor(serializeVisitor(v))).toEqual(v);
  });

  it("is v7's format: btoa(encodeURIComponent(JSON)) with v7's fields plus id", () => {
    const v = newVisitor();
    const body = JSON.parse(decodeURIComponent(atob(serializeVisitor(v))));
    expect(body).toEqual({ active: [], inactiveDrawn: [], pct: {}, id: v.id });
  });

  it("gives byte-equal values for equal visitors", () => {
    const a: Visitor = {
      id: "AAAAAAAAAAAAAAAAAAAAAA",
      active: ["b", "a"],
      inactiveDrawn: ["d", "c"],
      pct: { b: 50, a: 10, d: 1, c: 2 },
    };
    const b: Visitor = {
      id: "AAAAAAAAAAAAAAAAAAAAAA",
      active: ["a", "b"],
      inactiveDrawn: ["c", "d"],
      pct: { a: 10, b: 50, c: 2, d: 1 },
    };
    expect(serializeVisitor(a)).toBe(serializeVisitor(b));
  });

  it("stays under 2KB, dropping first the v7 entries the id reproduces", () => {
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    const v: Visitor = { id, active: [], inactiveDrawn: [], pct: {} };
    const unrecoverable: string[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `experiment-number-${i}`;
      const isIn = !(roll(name, id) < 50); // only v7 could have stored this
      (isIn ? v.active : v.inactiveDrawn).push(name);
      v.pct[name] = 50;
      unrecoverable.push(name);
    }
    for (let i = 0; i < 120; i++) {
      const name = `reproducible-${i}`;
      (roll(name, id) < 50 ? v.active : v.inactiveDrawn).push(name);
      v.pct[name] = 50;
    }
    const value = serializeVisitor(v);
    expect(value.length).toBeLessThanOrEqual(2048);
    const written = parseVisitor(value) as Visitor;
    const kept = new Set([...written.active, ...written.inactiveDrawn]);
    for (const name of unrecoverable) expect(kept.has(name), name).toBe(true);
    expect(kept.size).toBeLessThan(140);
  });

  it("parses to null when missing, broken, hostile, or without an id (never throws)", () => {
    const junk = [
      undefined,
      null,
      "",
      "not-base64!!",
      btoa("not json"),
      v7Value(null as never),
      btoa(encodeURIComponent(JSON.stringify([1, 2, 3]))),
      v7Value({ active: [], inactiveDrawn: [], pct: {} }), // v7: no id
      v7Value({ id: "../../etc/passwd", active: [], inactiveDrawn: [], pct: {} }),
    ];
    for (const text of junk) {
      expect(() => parseVisitor(text)).not.toThrow();
      expect(parseVisitor(text), String(text)).toBeNull();
    }
  });

  it("drops entries of the wrong type instead of trusting them", () => {
    const parsed = parseVisitor(
      v7Value({
        id: "AAAAAAAAAAAAAAAAAAAAAA",
        active: ["ok", 42, null],
        inactiveDrawn: ["fine"],
        pct: { ok: 50, bad: "50" },
        exp: { a: "arm", b: 7 },
      }),
    ) as Visitor;
    expect(parsed.active).toEqual(["ok"]);
    expect({ ...parsed.pct }).toEqual({ ok: 50 });
    expect({ ...parsed.exp }).toEqual({ a: "arm" });
  });

  it("reads a percent-encoded value, as a cookie API that encodes what it writes leaves it", () => {
    const v = newVisitor();
    const value = serializeVisitor(v);
    expect(parseVisitor(encodeURIComponent(value))?.id).toBe(v.id);
  });

  it("newVisitor draws a fresh 22-character id each time", () => {
    const a = newVisitor();
    const b = newVisitor();
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ active: [], inactiveDrawn: [] });
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

  it("gives a v7 visitor an id, keeping every decision v7 stored", () => {
    const body = {
      active: ["pdp-cta"],
      inactiveDrawn: ["hero-copy"],
      pct: { "pdp-cta": 50, "hero-copy": 10, "legacy-nway": 30 },
      exp: { "legacy-nway": "arm-b" },
    };
    const { visitor: read, cookie } = readVisitor(requestWith(`${COOKIE}=${v7Value(body)}`));
    expect(read.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const written = parseVisitor((cookie as string).split(";")[0].slice(COOKIE.length + 1));
    expect(written).toEqual(read);
    expect(written).toMatchObject({ ...body, id: read.id });
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
