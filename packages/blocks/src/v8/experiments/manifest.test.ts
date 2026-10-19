import { describe, expect, it } from "vitest";
import { type Experiment, experiment } from "./experiment.ts";
import {
  type ExperimentProblem,
  experimentManifest,
  LIMITS,
  validateExperiment,
} from "./manifest.ts";

const halves = [
  { id: "control", weight: 50 },
  { id: "variant", weight: 50 },
];
const ab = (key: string, extra: Partial<Experiment> = {}): Experiment => ({
  key,
  variants: halves,
  ...extra,
});
const codes = (input: unknown): ExperimentProblem[] => validateExperiment(input).map((e) => e.code);

describe("validateExperiment", () => {
  it("accepts a well-formed experiment", () => {
    expect(validateExperiment(ab("plp-ranking"))).toEqual([]);
  });

  it("accepts hyphens, digits and underscores in keys and arm ids", () => {
    expect(
      validateExperiment({
        key: "pdp_buy-button-2",
        variants: [
          { id: "a1", weight: 1 },
          { id: "b_2", weight: 1 },
        ],
      }),
    ).toEqual([]);
  });

  describe("the key", () => {
    it("is required", () => {
      expect(codes(ab(""))).toContain("KEY_REQUIRED");
    });

    it("is refused uppercase, because analytics drops it without an error", () => {
      expect(codes(ab("bannerXPTO"))).toEqual(["KEY_CHARSET"]);
    });

    it.each(["-leading", "_leading", "has space", "has.dot", "acentuação"])("refuses %o", (key) => {
      expect(codes(ab(key))).toContain("KEY_CHARSET");
    });

    it("is bounded at the length the collector would truncate to", () => {
      expect(codes(ab("a".repeat(LIMITS.keyLength)))).toEqual([]);
      expect(codes(ab("a".repeat(LIMITS.keyLength + 1)))).toEqual(["KEY_TOO_LONG"]);
    });
  });

  describe("the arms", () => {
    it("need at least two: one arm is a rollout", () => {
      expect(codes(ab("t", { variants: [{ id: "only", weight: 100 }] }))).toContain(
        "TOO_FEW_VARIANTS",
      );
      expect(codes(ab("t", { variants: [] }))).toContain("TOO_FEW_VARIANTS");
    });

    it("are bounded, so a typo cannot make a test no sample size resolves", () => {
      const many = Array.from({ length: LIMITS.maxVariants + 1 }, (_, i) => ({
        id: `arm-${i}`,
        weight: 1,
      }));
      expect(codes(ab("t", { variants: many }))).toContain("TOO_MANY_VARIANTS");
    });

    it("must have unique ids", () => {
      const twice = [
        { id: "same", weight: 1 },
        { id: "same", weight: 1 },
      ];
      expect(codes(ab("t", { variants: twice }))).toContain("VARIANT_ID_DUPLICATE");
    });

    it("must have ids in the collector's charset", () => {
      const bad = [
        { id: "Control", weight: 1 },
        { id: "variant", weight: 1 },
      ];
      expect(codes(ab("t", { variants: bad }))).toContain("VARIANT_ID_CHARSET");
    });

    it("must have numeric, non-negative weights", () => {
      const bad = [
        { id: "a", weight: Number.NaN },
        { id: "b", weight: -1 },
      ];
      expect(codes(ab("t", { variants: bad }))).toEqual([
        "WEIGHT_NOT_A_NUMBER",
        "WEIGHT_NOT_A_NUMBER",
        "WEIGHTS_SUM_TO_ZERO",
      ]);
    });
  });

  describe("the zero-weight arm — the rule neither upstream validator has", () => {
    const zeroed = [
      { id: "control", weight: 0 },
      { id: "variant", weight: 100 },
    ];

    it("refuses 0/100, which both the SDK and Studio accept today", () => {
      // The SDK's `validateTest` passes it: the total is positive.
      // Studio's `variantsInputSchema` passes it: 0 + 100 === 100.
      // In production it put 100% of traffic on `variant` for five days.
      expect(codes(ab("sem-banner", { variants: zeroed }))).toEqual(["ZERO_WEIGHT_ARM"]);
    });

    it("names the arm, so the message says which one to fix", () => {
      const [error] = validateExperiment(ab("t", { variants: zeroed }));
      expect(error.message).toContain('"control"');
    });

    it("is separate from weights summing to zero", () => {
      const bothZero = [
        { id: "a", weight: 0 },
        { id: "b", weight: 0 },
      ];
      expect(codes(ab("t", { variants: bothZero }))).toEqual([
        "ZERO_WEIGHT_ARM",
        "ZERO_WEIGHT_ARM",
        "WEIGHTS_SUM_TO_ZERO",
      ]);
    });
  });

  it("reports every problem at once, not just the first", () => {
    expect(codes({ key: "BAD KEY", variants: [{ id: "Only", weight: 0 }] }).length).toBeGreaterThan(
      2,
    );
  });

  it.each([null, undefined, 42, "a string", []])("does not throw on %o", (input) => {
    expect(() => validateExperiment(input)).not.toThrow();
    expect(validateExperiment(input).length).toBeGreaterThan(0);
  });
});

describe("experimentManifest", () => {
  it("maps the content's `key` onto the wire's `name`", () => {
    expect(experimentManifest([ab("plp-ranking")]).manifest.tests).toEqual([
      { name: "plp-ranking", enabled: true, variants: halves },
    ]);
  });

  it("drops an invalid experiment instead of throwing, and reports why", () => {
    const { manifest, skipped } = experimentManifest([
      ab("good"),
      ab("BAD"),
      ab("zero", {
        variants: [
          { id: "control", weight: 0 },
          { id: "variant", weight: 100 },
        ],
      }),
    ]);
    expect(manifest.tests.map((t) => t.name)).toEqual(["good"]);
    expect(skipped.map((s) => [s.key, s.errors.map((e) => e.code)])).toEqual([
      ["BAD", ["KEY_CHARSET"]],
      ["zero", ["ZERO_WEIGHT_ARM"]],
    ]);
  });

  it("leaves a stopped experiment out, so it never reaches the browser", () => {
    const { manifest, skipped } = experimentManifest([
      ab("live"),
      ab("stopped", { enabled: false }),
    ]);
    expect(manifest.tests.map((t) => t.name)).toEqual(["live"]);
    expect(skipped).toEqual([]);
  });

  it("keeps only what assignment needs — not the hypothesis", () => {
    const { manifest } = experimentManifest([
      ab("t", {
        name: "Human label",
        variants: [
          { id: "control", weight: 50, role: "control", description: "today's banner" },
          { id: "variant", weight: 50, role: "treatment", description: "no banner at all" },
        ],
      }),
    ]);
    expect(JSON.stringify(manifest)).not.toContain("no banner at all");
    expect(JSON.stringify(manifest)).not.toContain("Human label");
    expect(manifest.tests[0].variants).toEqual(halves);
  });

  it("canonicalises arm order, so a drag in the editor does not reshuffle visitors", () => {
    const reversed = [
      { id: "variant", weight: 50 },
      { id: "control", weight: 50 },
    ];
    const { manifest } = experimentManifest([ab("t", { variants: reversed })]);
    expect(manifest.tests[0].variants.map((v) => v.id)).toEqual(["control", "variant"]);
  });

  it("serialises to the same bytes whatever order the content came in", () => {
    const one = experimentManifest([ab("b"), ab("a"), ab("c")]).manifest;
    const two = experimentManifest([ab("c"), ab("b"), ab("a")]).manifest;
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  /**
   * Code-unit order, NOT `localeCompare`. ICU collation depends on the locale
   * and on the runtime's ICU build, and `_` and `-` — both legal here — are
   * exactly where the two disagree: under `localeCompare` these arms sort
   * `["a_b","a-1","a-b","a1","ab"]`. Since the SDK walks the arms in the
   * order this file emits, a manifest built on full-icu Node and one built on
   * workerd would otherwise split the same population differently.
   */
  it("orders arms and tests by code unit, so no runtime's ICU can change the split", () => {
    const ids = ["ab", "a-b", "a_b", "a1", "a-1", "b"].map((id) => ({ id, weight: 1 }));
    const { manifest } = experimentManifest([ab("t", { variants: ids }), ab("a_b"), ab("a-b")]);

    const arms = manifest.tests.find((t) => t.name === "t");
    expect(arms?.variants.map((v) => v.id)).toEqual(["a-1", "a-b", "a1", "a_b", "ab", "b"]);
    expect(manifest.tests.map((t) => t.name)).toEqual(["a-b", "a_b", "t"]);
  });

  it("flags more concurrent tests than analytics can carry on an event", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ab(`t-${i}`));
    expect(experimentManifest(eight).overConcurrencyLimit).toBe(false);
    expect(experimentManifest([...eight, ab("t-8")]).overConcurrencyLimit).toBe(true);
  });

  it("is empty, not broken, with no experiments at all", () => {
    expect(experimentManifest([])).toEqual({
      manifest: { tests: [] },
      skipped: [],
      overConcurrencyLimit: false,
    });
  });
});

describe("the experiment block", () => {
  it("treats a saved experiment with no flag as live", () => {
    expect(experiment({ key: "t" }).enabled).toBe(true);
    expect(experiment({ key: "t", enabled: false }).enabled).toBe(false);
  });

  it("gives an arm list even when none was saved", () => {
    expect(experiment({ key: "t" }).variants).toEqual([]);
  });

  it("does not mutate the saved block", () => {
    const saved: Experiment = { key: "t" };
    experiment(saved);
    expect(saved).toEqual({ key: "t" });
  });
});
