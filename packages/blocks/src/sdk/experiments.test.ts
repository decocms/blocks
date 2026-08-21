import { describe, expect, it } from "vitest";
import {
  type ExperimentConfig,
  pickWeightedVariant,
  readExperimentConfig,
  resolveExperimentVariant,
  weightsFingerprint,
} from "./experiments";
import {
  parseSegmentCookie,
  type StoredFlag,
  segmentCacheToken,
  serializeSegmentCookie,
} from "./flags";

type Payload = { collectionId: string };

/** Contract 1's example document, verbatim. */
const CONFIG: ExperimentConfig<Payload> = {
  version: 1,
  experiments: [
    {
      key: "plp-ranking",
      variants: [
        { id: "control", weight: 95, payload: { collectionId: "139" } },
        { id: "model-b", weight: 5, payload: { collectionId: "412" } },
      ],
    },
  ],
};

/** Same experiment after a ramp stage advances 5% -> 10%. */
const RAMPED: ExperimentConfig<Payload> = {
  version: 1,
  experiments: [
    {
      key: "plp-ranking",
      variants: [
        { id: "control", weight: 90, payload: { collectionId: "139" } },
        { id: "model-b", weight: 10, payload: { collectionId: "412" } },
      ],
    },
  ],
};

/**
 * One request: a cookie in, a fresh assignment sink, a fixed RNG sample.
 * Mirrors what the framework threads through in production.
 */
function request(
  config: ExperimentConfig<Payload> | null,
  cookie: string | undefined,
  rand: number,
) {
  const assignments: StoredFlag[] = [];
  const resolve = () =>
    resolveExperimentVariant<Payload>("plp-ranking", {
      config,
      segmentCookie: cookie,
      assignments,
      random: () => rand,
    });
  // The cookie the framework would write back (persistFlags merges the same way).
  const nextCookie = () =>
    serializeSegmentCookie([
      ...parseSegmentCookie(cookie).filter((f) => !assignments.some((a) => a.name === f.name)),
      ...assignments,
    ]);
  return { resolve, assignments, nextCookie };
}

describe("pickWeightedVariant", () => {
  const variants = CONFIG.experiments[0].variants;

  it("splits the range in proportion to the weights", () => {
    expect(pickWeightedVariant(variants, 0)).toBe("control");
    expect(pickWeightedVariant(variants, 0.94)).toBe("control");
    expect(pickWeightedVariant(variants, 0.96)).toBe("model-b");
    // 0.9999 must not fall off the end into `undefined`.
    expect(pickWeightedVariant(variants, 0.9999)).toBe("model-b");
  });

  it("holds the distribution over many draws", () => {
    let modelB = 0;
    for (let i = 0; i < 10_000; i++) {
      if (pickWeightedVariant(variants, i / 10_000) === "model-b") modelB++;
    }
    expect(modelB / 10_000).toBeCloseTo(0.05, 2);
  });

  it("handles N > 2 arms", () => {
    const three = [
      { id: "a", weight: 50, payload: {} },
      { id: "b", weight: 30, payload: {} },
      { id: "c", weight: 20, payload: {} },
    ];
    expect(pickWeightedVariant(three, 0.1)).toBe("a");
    expect(pickWeightedVariant(three, 0.6)).toBe("b");
    expect(pickWeightedVariant(three, 0.9)).toBe("c");
  });

  it("still splits proportionally when weights violate the sum-to-100 contract", () => {
    const bad = [
      { id: "a", weight: 1, payload: {} },
      { id: "b", weight: 1, payload: {} },
    ];
    expect(pickWeightedVariant(bad, 0.25)).toBe("a");
    expect(pickWeightedVariant(bad, 0.75)).toBe("b");
  });
});

describe("weightsFingerprint", () => {
  it("changes when a weight changes", () => {
    expect(weightsFingerprint(CONFIG.experiments[0].variants)).not.toBe(
      weightsFingerprint(RAMPED.experiments[0].variants),
    );
  });

  it("is stable under variant reordering", () => {
    const reversed = [...CONFIG.experiments[0].variants].reverse();
    expect(weightsFingerprint(reversed)).toBe(weightsFingerprint(CONFIG.experiments[0].variants));
  });

  it("never collides with the legacy -1 sentinel", () => {
    expect(weightsFingerprint(CONFIG.experiments[0].variants)).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveExperimentVariant — first assignment", () => {
  it("assigns a fresh visitor and reports isFresh", async () => {
    const { resolve, assignments } = request(CONFIG, undefined, 0.99);
    const variant = await resolve();

    expect(variant).toEqual({
      experimentKey: "plp-ranking",
      variantId: "model-b",
      payload: { collectionId: "412" },
      isFresh: true,
    });
    expect(assignments).toEqual([
      {
        name: "plp-ranking",
        value: "model-b",
        pct: weightsFingerprint(CONFIG.experiments[0].variants),
      },
    ]);
  });

  it("routes the majority of fresh visitors to the heavy arm", async () => {
    const { resolve } = request(CONFIG, undefined, 0.5);
    expect((await resolve())?.variantId).toBe("control");
  });

  it("returns null when no config is published", async () => {
    expect(await request(null, undefined, 0.5).resolve()).toBeNull();
  });

  it("returns null when the key is not among the active experiments", async () => {
    const other: ExperimentConfig<Payload> = { version: 1, experiments: [] };
    expect(await resolveExperimentVariant<Payload>("plp-ranking", { config: other })).toBeNull();
  });

  it("resolves once per request even when several loaders ask", async () => {
    const { resolve, assignments } = request(CONFIG, undefined, 0.99);
    const [a, b] = [await resolve(), await resolve()];

    expect(b?.variantId).toBe(a?.variantId);
    expect(b?.isFresh).toBe(false); // only the first call assigned
    expect(assignments).toHaveLength(1);
  });
});

describe("resolveExperimentVariant — stickiness across requests", () => {
  it("re-serves the stored variant without re-rolling", async () => {
    const first = request(CONFIG, undefined, 0.99);
    expect((await first.resolve())?.variantId).toBe("model-b");
    const cookie = first.nextCookie();

    // Next request: an RNG sample that WOULD have drawn "control".
    const second = request(CONFIG, cookie, 0.1);
    const variant = await second.resolve();

    expect(variant?.variantId).toBe("model-b");
    expect(variant?.payload).toEqual({ collectionId: "412" });
    expect(variant?.isFresh).toBe(false);
  });

  it("stays sticky over many requests with adversarial RNG", async () => {
    let cookie = request(CONFIG, undefined, 0.99).nextCookie();
    const first = request(CONFIG, undefined, 0.99);
    await first.resolve();
    cookie = first.nextCookie();

    for (const rand of [0, 0.2, 0.5, 0.94, 0.999]) {
      const req = request(CONFIG, cookie, rand);
      expect((await req.resolve())?.variantId).toBe("model-b");
      cookie = req.nextCookie();
    }
  });

  it("honours a classic-deco cookie that carries no fingerprint", async () => {
    // pct absent -> parses as -1 -> must stick, not churn every legacy visitor.
    const legacy = btoa(encodeURIComponent(JSON.stringify({ exp: { "plp-ranking": "model-b" } })));
    const variant = await request(CONFIG, legacy, 0.1).resolve();

    expect(variant?.variantId).toBe("model-b");
    expect(variant?.isFresh).toBe(false);
  });

  it("re-rolls a visitor holding a variant that no longer exists", async () => {
    const stale = serializeSegmentCookie([
      {
        name: "plp-ranking",
        value: "model-z",
        pct: weightsFingerprint(CONFIG.experiments[0].variants),
      },
    ]);
    const variant = await request(CONFIG, stale, 0.1).resolve();

    expect(variant?.variantId).toBe("control");
    expect(variant?.isFresh).toBe(true);
  });
});

describe("resolveExperimentVariant — re-roll once, then stick, when weights change", () => {
  it("re-rolls on the ramp and re-sticks on the new weights", async () => {
    // Assigned under 95/5.
    const first = request(CONFIG, undefined, 0.99);
    expect((await first.resolve())?.variantId).toBe("model-b");
    const beforeRamp = first.nextCookie();

    // Ramp to 90/10: the stored fingerprint goes stale -> exactly one re-roll.
    const rerolled = request(RAMPED, beforeRamp, 0.5);
    const afterRamp = await rerolled.resolve();
    expect(afterRamp?.isFresh).toBe(true);
    expect(afterRamp?.variantId).toBe("control"); // 0.5 lands in the 90% arm
    const afterRampCookie = rerolled.nextCookie();

    // Every subsequent request sticks — no second re-roll.
    for (const rand of [0.99, 0.01, 0.5]) {
      const req = request(RAMPED, afterRampCookie, rand);
      const variant = await req.resolve();
      expect(variant?.variantId).toBe("control");
      expect(variant?.isFresh).toBe(false);
    }
  });

  it("writes the new fingerprint so the re-roll cannot repeat", async () => {
    const first = request(CONFIG, undefined, 0.99);
    await first.resolve();

    const rerolled = request(RAMPED, first.nextCookie(), 0.5);
    await rerolled.resolve();

    expect(rerolled.assignments[0].pct).toBe(weightsFingerprint(RAMPED.experiments[0].variants));
  });
});

describe("deco_segment carries the assignment (contract 4)", () => {
  it("stores the variant id under the experiment key", async () => {
    const req = request(CONFIG, undefined, 0.99);
    await req.resolve();

    const payload = JSON.parse(decodeURIComponent(atob(req.nextCookie())));
    expect(payload.exp).toEqual({ "plp-ranking": "model-b" });
    // Boolean buckets stay untouched, so analytics reading `active` is unaffected.
    expect(payload.active).toEqual([]);
  });

  it("coexists with a CMS boolean flag in the same cookie", async () => {
    const withFlag = serializeSegmentCookie([{ name: "TestHero", value: true, pct: 50 }]);
    const req = request(CONFIG, withFlag, 0.99);
    await req.resolve();

    const payload = JSON.parse(decodeURIComponent(atob(req.nextCookie())));
    expect(payload.active).toEqual(["TestHero"]);
    expect(payload.exp).toEqual({ "plp-ranking": "model-b" });
    expect(parseSegmentCookie(req.nextCookie())).toEqual(
      expect.arrayContaining([
        { name: "TestHero", value: true, pct: 50 },
        { name: "plp-ranking", value: "model-b", pct: expect.any(Number) },
      ]),
    );
  });

  it("folds into the CDN cache key so two variants never share cached HTML", async () => {
    const a = request(CONFIG, undefined, 0.99);
    const b = request(CONFIG, undefined, 0.1);
    await a.resolve();
    await b.resolve();

    const tokenA = segmentCacheToken(parseSegmentCookie(a.nextCookie()));
    const tokenB = segmentCacheToken(parseSegmentCookie(b.nextCookie()));
    expect(tokenA).not.toBe(tokenB);
  });

  it("keeps the cookie byte-identical to today when no experiment is assigned", () => {
    const flags: StoredFlag[] = [{ name: "TestHero", value: true, pct: 50 }];
    const payload = JSON.parse(decodeURIComponent(atob(serializeSegmentCookie(flags))));
    expect("exp" in payload).toBe(false);
  });
});

describe("readExperimentConfig", () => {
  const kv = (value: unknown) => ({ get: async () => value as never });

  it("reads contract 1's document", async () => {
    expect(await readExperimentConfig(kv(CONFIG), "www.farmrio.com")).toEqual(CONFIG);
  });

  it("returns null instead of throwing when the binding is missing", async () => {
    expect(await readExperimentConfig(undefined, "www.farmrio.com")).toBeNull();
  });

  it("returns null on an unset key or a malformed document", async () => {
    expect(await readExperimentConfig(kv(null), "www.farmrio.com")).toBeNull();
    expect(await readExperimentConfig(kv({ version: 1 }), "www.farmrio.com")).toBeNull();
  });

  it("returns null when KV itself fails — never a thrown request", async () => {
    const broken = {
      get: async () => {
        throw new Error("KV unavailable");
      },
    };
    expect(await readExperimentConfig(broken, "www.farmrio.com")).toBeNull();
  });
});
