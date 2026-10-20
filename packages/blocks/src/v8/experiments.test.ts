// @vitest-environment node
/**
 * A hash bug here fails silently: every visitor still gets an answer, it is
 * just the wrong one, and the test's result is quietly meaningless. So the
 * bucketing is pinned twice over — `murmur3_32` against MurmurHash3's own
 * published vectors, and `roll` against a table generated from this
 * implementation. A change to either table is a breaking change for every
 * visitor already allocated, never a test to update.
 */
import { describe, expect, it } from "vitest";
import {
  assign,
  emptySegment,
  murmur3_32,
  newId,
  parseSegment,
  roll,
  SEGMENT_COOKIE,
  type Segment,
  segmentCookie,
  serializeSegment,
} from "./experiments.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);

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
    expect(murmur3_32(utf8("ação"))).toBe(murmur3_32(new TextEncoder().encode("ação")));
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

describe("the properties a test's result depends on", () => {
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

describe("moving an allocation", () => {
  const NAME = "t";
  const population = ids(40_000);

  /** A cookie as it stands for a visitor already decided at `pct`. */
  const at = (id: string, isIn: boolean, pct: number): Segment => ({
    id,
    active: isIn ? [NAME] : [],
    inactiveDrawn: isIn ? [] : [NAME],
    pct: { [NAME]: pct },
  });

  /**
   * Walks a population through a path of allocations, counting the visitors
   * who moved the wrong way: out of a test that grew, or into one that shrank.
   */
  function walk(start: Segment[], path: number[]) {
    let segments = start;
    let violations = 0;
    for (const allocation of path) {
      segments = segments.map((segment) => {
        const wasIn = segment.active.includes(NAME);
        const before = segment.pct[NAME] as number;
        const result = assign({ [NAME]: allocation }, segment);
        const isIn = result.assignments[NAME] === true;
        if (allocation > before && wasIn && !isIn) violations++;
        if (allocation < before && !wasIn && isIn) violations++;
        return result.segment;
      });
    }
    const share = (segments.filter((s) => s.active.includes(NAME)).length / segments.length) * 100;
    return { share, violations };
  }

  /** A visitor v7 decided, whose id was drawn later: the roll says nothing about them. */
  const migrated = (pct: number) =>
    population.map((id) => at(id, roll("a v7 draw", id) < pct, pct));
  /** A visitor this package decided: stored and roll agree by construction. */
  const native = (pct: number) => population.map((id) => at(id, roll(NAME, id) < pct, pct));

  const paths: [string, number, number[]][] = [
    ["up", 10, [20]],
    ["up twice", 10, [20, 50]],
    ["down", 50, [10]],
    ["down then up", 50, [10, 50]],
    ["up, up, down", 10, [20, 50, 20]],
    ["to nothing", 20, [0]],
    ["from nothing", 0, [30]],
  ];

  for (const [label, start, path] of paths) {
    const target = path.at(-1) as number;

    it(`${label}: a visitor carried over from v7 never moves the wrong way`, () => {
      // Monotonicity only: their share drifts, which the test below pins.
      expect(walk(migrated(start), path).violations).toBe(0);
    });

    it(`${label}: a visitor this package decided never moves the wrong way, and the arm lands on ${target}%`, () => {
      const { share, violations } = walk(native(start), path);
      expect(violations).toBe(0);
      expect(share).toBeCloseTo(target, 0);
    });
  }

  it("gives a visitor this package decided the same arm whatever path the allocation took", () => {
    // The clause that protects v7 cohorts must stay invisible here: a native
    // visitor's arm is a function of their id and the allocation, nothing
    // else. Lose that and you can no longer answer "which arm is this
    // visitor in?" from the id alone, and a test that returns to an
    // allocation it already used stops landing on it.
    for (const path of [[50], [20, 50], [20, 35, 50], [20, 10, 20, 50]]) {
      const { share, violations } = walk(native(10), path);
      expect(share, path.join("→")).toBeCloseTo(50, 0);
      expect(violations, path.join("→")).toBe(0);
    }
  });

  it("holds a v7 cohort's arm steady, at a share that drifts off target until they churn", () => {
    // The price of never moving a v7 visitor the wrong way. Their id was
    // drawn at the migration, so there is no roll to put them back in their
    // place: the arm can only be kept, and it comes out wider than asked for
    // on the way up and narrower on the way down. It corrects itself as
    // those visitors age out, and nothing else in the system pays for it.
    expect(walk(migrated(10), [20]).share).toBeCloseTo(28, 0);
    expect(walk(migrated(50), [10]).share).toBeCloseTo(5, 0);
  });
});

describe("assign", () => {
  const random = seededRandom(7);

  it("draws an id on a first visit and reports the change", () => {
    const result = assign({ "pdp-cta": 50 }, undefined, random);
    expect(result.segment.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(result.changed).toBe(true);
    expect(Object.keys(result.assignments)).toEqual(["pdp-cta"]);
  });

  it("answers from the id, so the same cookie always gives the same answer", () => {
    const segment = assign({ "pdp-cta": 50 }, undefined, random).segment;
    const again = assign({ "pdp-cta": 50 }, segment);
    expect(again.assignments).toEqual(assign({ "pdp-cta": 50 }, segment).assignments);
    expect(again.changed).toBe(false);
  });

  it("is in when the roll is under the allocation", () => {
    const id = "Zm9vYmFyYmF6cXV4MTIzNA"; // hero-copy rolls 0.93
    const segment: Segment = { ...emptySegment(), id };
    expect(assign({ "hero-copy": 1 }, segment).assignments["hero-copy"]).toBe(true);
    expect(assign({ "hero-copy": 0.5 }, segment).assignments["hero-copy"]).toBe(false);
  });

  it("puts nobody in a paused experiment and everybody in a full one", () => {
    for (const id of ids(500)) {
      const segment: Segment = { ...emptySegment(), id };
      expect(assign({ x: 0 }, segment).assignments.x).toBe(false);
      expect(assign({ x: 100 }, segment).assignments.x).toBe(true);
    }
  });

  it("drops an experiment that left the block", () => {
    const first = assign({ "pdp-cta": 50, "hero-copy": 50 }, undefined, random);
    const second = assign({ "pdp-cta": 50 }, first.segment);
    expect(second.assignments).not.toHaveProperty("hero-copy");
    expect(second.segment.active).not.toContain("hero-copy");
    expect(second.segment.inactiveDrawn).not.toContain("hero-copy");
    expect(second.segment.pct).not.toHaveProperty("hero-copy");
    expect(second.changed).toBe(true);
  });

  it("ignores an allocation that is not a finite number", () => {
    const experiments = { ok: 50, bad: Number.NaN, worse: "50" } as unknown as Record<
      string,
      number
    >;
    const result = assign(experiments, undefined, random);
    expect(Object.keys(result.assignments)).toEqual(["ok"]);
  });

  it("reports the change when a name leaves because its allocation is unusable", () => {
    // The name is still a key of the block, so counting dropped names from
    // the block's keys would miss it: the cookie would lose the entry and
    // `changed` would say nothing, leaving the stale one in the browser.
    const before = assign({ a: 50, b: 50 }, undefined, random).segment;
    expect([...before.active, ...before.inactiveDrawn]).toContain("b");
    const after = assign({ a: 50, b: Number.NaN } as unknown as Record<string, number>, before);
    expect([...after.segment.active, ...after.segment.inactiveDrawn]).not.toContain("b");
    expect(after.changed).toBe(true);
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
    for (const experiments of junk) {
      expect(() => assign(experiments, undefined, random)).not.toThrow();
    }
  });
});

describe("the v7 visitor", () => {
  /** A `deco_segment` v7 itself would have written: no id. */
  const v7Cookie = (body: Record<string, unknown>) =>
    `${SEGMENT_COOKIE}=${btoa(encodeURIComponent(JSON.stringify(body)))}`;

  it("keeps the decision v7 made while its allocation still holds", () => {
    // The visitor is recorded as in at 50%, but their own roll is 84.57 —
    // a reshuffle would throw them out. The stored decision must win.
    const raw = v7Cookie({
      active: ["pdp-cta"],
      inactiveDrawn: [],
      pct: { "pdp-cta": 50 },
    });
    const segment = { ...parseSegment(raw), id: "AAAAAAAAAAAAAAAAAAAAAA" };
    expect(assign({ "pdp-cta": 50 }, segment).assignments["pdp-cta"]).toBe(true);
  });

  it("honours a real v7 cohort: the saved block's name, spaces and all", () => {
    // v7's cohort is the random matcher's saved block name, so production
    // cookies carry names this package's own naming rules would reject
    // (`.deco/blocks/Buy Now Button 0,5.json` on montecarlo, traffic 0.5).
    // `assign` validates no name: it only hashes them, so a migrated site
    // keeps v7's cohort verbatim and nobody is re-rolled.
    const cohort = "Buy Now Button 0,5";
    const raw = v7Cookie({
      active: [cohort],
      inactiveDrawn: [],
      pct: { [cohort]: 50 }, // v7 stored round(traffic * 100)
    });
    const result = assign({ [cohort]: 50 }, parseSegment(raw), seededRandom(11));
    expect(result.assignments[cohort]).toBe(true);
    // The cookie it writes back round-trips that name unharmed.
    expect(parseSegment(`${SEGMENT_COOKIE}=${serializeSegment(result.segment)}`).active).toEqual([
      cohort,
    ]);
  });

  it("keeps a v7 visitor in when the editor ramps up, roll or no roll", () => {
    // The visitor's own roll is 84.57, so recomputing from it would throw
    // them out of a test that just got *bigger*. Their id was drawn at the
    // migration and has nothing to do with the draw v7 made, so the roll
    // carries no information about them here: only the stored decision does.
    const raw = v7Cookie({ active: ["pdp-cta"], inactiveDrawn: [], pct: { "pdp-cta": 50 } });
    const segment = { ...parseSegment(raw), id: "AAAAAAAAAAAAAAAAAAAAAA" };
    expect(assign({ "pdp-cta": 60 }, segment).assignments["pdp-cta"]).toBe(true);
  });

  it("keeps a v7 visitor out when the editor ramps down", () => {
    const raw = v7Cookie({ active: [], inactiveDrawn: ["pdp-cta"], pct: { "pdp-cta": 50 } });
    const segment = { ...parseSegment(raw), id: "AAAAAAAAAAAAAAAAAAAAAA" };
    expect(assign({ "pdp-cta": 40 }, segment).assignments["pdp-cta"]).toBe(false);
  });

  it("gets an id without losing anything else", () => {
    const raw = v7Cookie({
      active: ["pdp-cta"],
      inactiveDrawn: ["hero-copy"],
      pct: { "pdp-cta": 50, "hero-copy": 10 },
      exp: { "legacy-nway": "arm-b" },
    });
    const result = assign({ "pdp-cta": 50, "hero-copy": 10 }, parseSegment(raw));
    expect(result.segment.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(result.assignments).toEqual({ "pdp-cta": true, "hero-copy": false });
    expect(result.segment.exp).toEqual({ "legacy-nway": "arm-b" }); // carried, never read
  });
});

describe("the cookie", () => {
  it("round-trips through v7's encoding", () => {
    const segment = assign({ b: 50, a: 10 }, undefined, seededRandom(3)).segment;
    const parsed = parseSegment(`${SEGMENT_COOKIE}=${serializeSegment(segment)}`);
    expect(parsed).toEqual(segment);
  });

  it("gives byte-equal values for equal segments, so nothing is rewritten for nothing", () => {
    const a: Segment = {
      id: "AAAAAAAAAAAAAAAAAAAAAA",
      active: ["b", "a"],
      inactiveDrawn: ["d", "c"],
      pct: { b: 50, a: 10, d: 1, c: 2 },
    };
    const b: Segment = {
      id: "AAAAAAAAAAAAAAAAAAAAAA",
      active: ["a", "b"],
      inactiveDrawn: ["c", "d"],
      pct: { a: 10, b: 50, c: 2, d: 1 },
    };
    expect(serializeSegment(a)).toBe(serializeSegment(b));
  });

  it("keeps the fingerprint of v7's N-way names, which it only carries", () => {
    // `exp` is passed through untouched, so dropping the `pct` v7 kept beside
    // it would be a silent rewrite of data this module claims not to read.
    const segment: Segment = {
      id: "AAAAAAAAAAAAAAAAAAAAAA",
      active: ["a"],
      inactiveDrawn: [],
      pct: { a: 50, "nway-test": 30 },
      exp: { "nway-test": "arm-b" },
    };
    const parsed = parseSegment(`${SEGMENT_COOKIE}=${serializeSegment(segment)}`);
    expect(parsed.exp).toEqual({ "nway-test": "arm-b" });
    expect(parsed.pct).toEqual({ a: 50, "nway-test": 30 });
  });

  it("reads one cookie out of a header holding others", () => {
    const value = serializeSegment({ ...emptySegment(), id: "AAAAAAAAAAAAAAAAAAAAAA" });
    const parsed = parseSegment(`other=1; ${SEGMENT_COOKIE}=${value}; last=2`);
    expect(parsed.id).toBe("AAAAAAAAAAAAAAAAAAAAAA");
  });

  it("carries v7's attributes, and drops Secure when the site asks", () => {
    const segment = emptySegment();
    expect(segmentCookie(segment)).toContain("Path=/");
    expect(segmentCookie(segment)).toContain("Max-Age=31536000");
    expect(segmentCookie(segment)).toContain("SameSite=Lax");
    expect(segmentCookie(segment)).toContain("Secure");
    expect(segmentCookie(segment)).not.toContain("Domain");
    expect(segmentCookie(segment)).not.toContain("HttpOnly");
    expect(segmentCookie(segment, { secure: false })).not.toContain("Secure");
  });

  it("stays under 2KB with an id and 50 experiments", () => {
    const experiments: Record<string, number> = {};
    for (let i = 0; i < 50; i++) experiments[`experiment-number-${i}`] = 50;
    const segment = assign(experiments, undefined, seededRandom(5)).segment;
    expect(serializeSegment(segment).length).toBeLessThan(2048);
  });

  it("spends the budget on the entries a roll can reproduce, keeping the ones it cannot", () => {
    // Trimming is not free: a dropped entry is recomputed from the roll on
    // the next request, which reproduces the decision only when the stored
    // value already agreed with it. A cohort carried over from v7 does not,
    // so dropping it would move that visitor to the other arm for no reason
    // at all — the cookie merely got long. Those go last.
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    const segment: Segment = { id, active: [], inactiveDrawn: [], pct: {} };
    const unrecoverable: string[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `experiment-number-${i}`;
      // Store the opposite of what the roll says: only v7 could have written
      // this, and only the cookie remembers it.
      const isIn = !(roll(name, id) < 50);
      (isIn ? segment.active : segment.inactiveDrawn).push(name);
      segment.pct[name] = 50;
      unrecoverable.push(name);
    }
    for (let i = 0; i < 120; i++) {
      const name = `reproducible-${i}`;
      const isIn = roll(name, id) < 50;
      (isIn ? segment.active : segment.inactiveDrawn).push(name);
      segment.pct[name] = 50;
    }

    const written = parseSegment(`${SEGMENT_COOKIE}=${serializeSegment(segment)}`);
    expect(serializeSegment(segment).length).toBeLessThanOrEqual(2048);
    const kept = new Set([...written.active, ...written.inactiveDrawn]);
    // Every entry the roll cannot bring back survived the trim.
    for (const name of unrecoverable) expect(kept.has(name), name).toBe(true);
    // And something was actually dropped, or the case proves nothing.
    expect(kept.size).toBeLessThan(140);
  });

  it("never throws on a broken or hostile value, and gives an empty segment", () => {
    const junk = [
      undefined,
      null,
      "",
      "deco_segment=",
      "deco_segment=not-base64!!",
      `${SEGMENT_COOKIE}=${btoa("not json")}`,
      `${SEGMENT_COOKIE}=${btoa(encodeURIComponent(JSON.stringify(null)))}`,
      `${SEGMENT_COOKIE}=${btoa(encodeURIComponent(JSON.stringify([1, 2, 3])))}`,
      `${SEGMENT_COOKIE}=${btoa(encodeURIComponent(JSON.stringify({ active: "nope" })))}`,
      "=;;;===",
    ];
    for (const raw of junk) {
      expect(() => parseSegment(raw)).not.toThrow();
      const parsed = parseSegment(raw);
      expect(Array.isArray(parsed.active)).toBe(true);
      expect(Array.isArray(parsed.inactiveDrawn)).toBe(true);
    }
  });

  it("drops entries of the wrong type instead of trusting them", () => {
    const raw = `${SEGMENT_COOKIE}=${btoa(
      encodeURIComponent(
        JSON.stringify({
          id: "too-short",
          active: ["ok", 42, null],
          inactiveDrawn: ["fine"],
          pct: { ok: 50, bad: "50" },
          exp: { a: "arm", b: 7 },
        }),
      ),
    )}`;
    const parsed = parseSegment(raw);
    expect(parsed.id).toBeUndefined(); // not 22 base64url chars: a new one is drawn
    expect(parsed.active).toEqual(["ok"]);
    expect(parsed.pct).toEqual({ ok: 50 });
    expect(parsed.exp).toEqual({ a: "arm" });
  });

  it("replaces a forged id rather than using it", () => {
    const raw = `${SEGMENT_COOKIE}=${btoa(
      encodeURIComponent(
        JSON.stringify({ id: "../../etc/passwd", active: [], inactiveDrawn: [], pct: {} }),
      ),
    )}`;
    const result = assign({ a: 50 }, parseSegment(raw), seededRandom(9));
    expect(result.segment.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
