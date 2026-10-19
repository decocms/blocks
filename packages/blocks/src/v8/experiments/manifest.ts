/**
 * Saved experiments to the document the browser reads, and the rules an
 * experiment has to pass to get there.
 *
 * ## Why validation lives here and not downstream
 *
 * The analytics collector never rejects an event. A test whose key falls
 * outside the charset is not refused: the `exp` entry is dropped, the event
 * is stored without it, and a truncation flag is set that nobody is
 * watching. The experiment then collects traffic for a week and produces a
 * result with no arm attached to it. So the rules are enforced where a human
 * is present to read the error — in the CMS, and in `deco check` in CI.
 *
 * The limits are inherited from `decocms/ab-testing`'s `shared/contract.mjs`,
 * which in turn copies them from the collector's own contract. If that
 * contract moves, this file moves with it.
 *
 * ## The one rule that is ours
 *
 * `ZERO_WEIGHT_ARM`. Neither validator upstream catches it: the SDK's
 * `validateTest` only requires the total to be positive, and Studio's
 * `variantsInputSchema` only requires the weights to sum to 100 — and
 * `{control: 0, variant: 100}` satisfies both. It reached production, where
 * the SDK skips any arm with weight ≤ 0 and sent 100% of visitors to
 * `variant` on two live tests for five days.
 */
import type {
  Experiment,
  ExperimentManifest,
  ExperimentVariant,
  ManifestTest,
} from "./experiment.ts";

/**
 * Lowercase alphanumeric, underscore and hyphen, not starting with a
 * separator. Hyphens on purpose: `plp-ranking` is the real shape of a key.
 *
 * NOTE THE LOWERCASE. `bannerXPTO` fails this, and it fails it silently at
 * the collector — the entry is dropped and the event kept. Use `banner-xpto`.
 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const LIMITS = {
  /**
   * Every active assignment rides on every analytics event, and the 9th is
   * dropped by the collector. Not a property of one experiment, so
   * `experimentManifest` reports it rather than refusing a save.
   */
  maxConcurrentTests: 8,
  /** The collector slices the key and the arm id to the same length. */
  keyLength: 60,
  variantIdLength: 60,
  /** Ours: a bound so a typo cannot produce a test no sample size resolves. */
  maxVariants: 10,
} as const;

export type ExperimentProblem =
  | "KEY_REQUIRED"
  | "KEY_TOO_LONG"
  | "KEY_CHARSET"
  | "TOO_FEW_VARIANTS"
  | "TOO_MANY_VARIANTS"
  | "VARIANT_ID_REQUIRED"
  | "VARIANT_ID_TOO_LONG"
  | "VARIANT_ID_CHARSET"
  | "VARIANT_ID_DUPLICATE"
  | "WEIGHT_NOT_A_NUMBER"
  | "WEIGHTS_SUM_TO_ZERO"
  | "ZERO_WEIGHT_ARM";

export interface ExperimentError {
  code: ExperimentProblem;
  /** Ready to show in the CMS, naming the key or arm that caused it. */
  message: string;
}

/**
 * Every problem with an experiment, not just the first — a CMS form that
 * reports one error per save makes a five-field form a five-round-trip form.
 * An empty array means it is safe to publish.
 */
export function validateExperiment(input: unknown): ExperimentError[] {
  const errors: ExperimentError[] = [];
  const add = (code: ExperimentProblem, message: string) => errors.push({ code, message });

  const experiment = (input ?? {}) as Partial<Experiment>;
  const key = typeof experiment.key === "string" ? experiment.key : "";

  if (!key) add("KEY_REQUIRED", "An experiment needs a key.");
  else if (key.length > LIMITS.keyLength) {
    add("KEY_TOO_LONG", `The key exceeds ${LIMITS.keyLength} characters; analytics would cut it.`);
  } else if (!NAME_PATTERN.test(key)) {
    add(
      "KEY_CHARSET",
      `The key "${key}" must be lowercase letters, digits, "_" and "-", starting with a letter ` +
        `or digit. Analytics drops an entry outside this charset without rejecting the event, ` +
        `so the test would look healthy and record nothing.`,
    );
  }

  const variants = Array.isArray(experiment.variants) ? experiment.variants : [];
  if (variants.length < 2) {
    add("TOO_FEW_VARIANTS", "An experiment needs at least 2 arms; one arm is a rollout.");
  }
  if (variants.length > LIMITS.maxVariants) {
    add("TOO_MANY_VARIANTS", `At most ${LIMITS.maxVariants} arms.`);
  }

  const seen = new Set<string>();
  let total = 0;
  for (const [i, variant] of variants.entries()) {
    const at = `Arm ${i + 1}`;
    const id = typeof variant?.id === "string" ? variant.id : "";

    if (!id) add("VARIANT_ID_REQUIRED", `${at} needs an id.`);
    else if (id.length > LIMITS.variantIdLength) {
      add("VARIANT_ID_TOO_LONG", `${at}: the id exceeds ${LIMITS.variantIdLength} characters.`);
    } else if (!NAME_PATTERN.test(id)) {
      add("VARIANT_ID_CHARSET", `${at}: the id "${id}" must match ${NAME_PATTERN.source}.`);
    }
    if (id && seen.has(id)) add("VARIANT_ID_DUPLICATE", `${at}: the id "${id}" is used twice.`);
    seen.add(id);

    const weight = Number(variant?.weight);
    if (!Number.isFinite(weight) || weight < 0) {
      add("WEIGHT_NOT_A_NUMBER", `${at}: the weight must be a number of 0 or more.`);
      continue;
    }
    if (weight === 0) {
      add(
        "ZERO_WEIGHT_ARM",
        `${at} ("${id}") has weight 0, so no visitor is ever assigned to it and the remaining ` +
          `arms take all the traffic. That is a rollout, not an experiment — remove the arm, ` +
          `or give it a share.`,
      );
    }
    total += weight;
  }

  if (variants.length > 0 && total <= 0) {
    add("WEIGHTS_SUM_TO_ZERO", "The weights sum to zero; no visitor would ever be assigned.");
  }

  return errors;
}

/**
 * Plain code-unit order: the same on every server, runtime and locale.
 *
 * NOT `localeCompare`, which collates through ICU and so depends on the
 * locale and on the runtime's ICU build. Both `_` and `-` are legal in an arm
 * id, and they are exactly where the two disagree — `["ab","a-b","a_b"]`
 * sorts one way under ICU and another by code unit. Since the SDK walks the
 * arms in the order this file emits them, a manifest built on full-icu Node
 * and one built on workerd would otherwise split the same population
 * differently from identical content. `client.ts` keeps its own copy of this
 * comparator for the same reason.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** An experiment left out of the manifest, and why. */
export interface SkippedExperiment {
  /** The `key` as saved — possibly the invalid one, so the report can name it. */
  key: string;
  errors: ExperimentError[];
}

export interface BuiltManifest {
  manifest: ExperimentManifest;
  /**
   * Experiments that did not make it in. NEVER DROP THIS SILENTLY: a site
   * should log it. An experiment missing because of a typo looks exactly like
   * one nobody started, and that is a week of waiting for data that was never
   * going to arrive.
   */
  skipped: SkippedExperiment[];
  /**
   * Set when more than `LIMITS.maxConcurrentTests` tests are live at once.
   * Past that the collector drops the surplus from each event's `exp` map, so
   * the extra tests run but cannot be measured.
   */
  overConcurrencyLimit: boolean;
}

/**
 * The manifest for a set of saved experiments.
 *
 * FAILS SAFE, LOUDLY. An invalid experiment is dropped rather than thrown on:
 * one malformed block must not take the storefront down. It lands in
 * `skipped` with the same errors `deco check` would have printed.
 *
 * Disabled experiments are dropped too. The SDK honours `enabled: false`
 * anyway, but shipping a stopped test to every browser leaks what is being
 * tried next and costs bytes on the critical path for nothing.
 *
 * CHEAP, BUT NOT FREE TO CALL. It is pure, so build it once per content
 * revision and cache it — `client.list` walks and expands every saved block,
 * and `cms.forRelease()` hands back a new client (and a cold memo) on every
 * call. Keying the cached manifest on `await client.revision()` is enough:
 * the revision changes exactly when the content does.
 */
export function experimentManifest(experiments: readonly Experiment[]): BuiltManifest {
  const tests: ManifestTest[] = [];
  const skipped: SkippedExperiment[] = [];

  for (const experiment of experiments) {
    const key = typeof experiment?.key === "string" ? experiment.key : "";
    const errors = validateExperiment(experiment);
    if (errors.length > 0) {
      skipped.push({ key, errors });
      continue;
    }
    if (experiment.enabled === false) continue;

    tests.push({
      name: key,
      enabled: true,
      // Only what assignment needs. `role` and `description` are for the CMS
      // and the analysis; putting them on the wire would ship the hypothesis
      // of a running test to anyone who opens devtools.
      variants: canonicalVariants(experiment.variants ?? []),
    });
  }

  tests.sort((a, b) => byCodeUnit(a.name, b.name));

  return {
    manifest: { tests },
    skipped,
    overConcurrencyLimit: tests.length > LIMITS.maxConcurrentTests,
  };
}

/**
 * Arms in a stable order, carrying only `id` and `weight`.
 *
 * ORDER IS PART OF THE ASSIGNMENT CONTRACT. The SDK walks `variants` in array
 * order and deliberately does not re-sort them, so the same weights in a
 * different order split the same population differently. Sorting by id makes
 * the order a function of the content rather than of however the editor
 * happened to save it — otherwise dragging two arms in Studio reshuffles
 * every visitor already in the test, for nothing.
 *
 * One migration note: the KV documents this replaces were sorted with
 * `localeCompare`. For ids that are plain lowercase letters the two agree, so
 * a test moving from KV to `.deco` keeps its order; one whose ids mix `_` or
 * `-` with letters can shift, which re-buckets its visitors once.
 */
function canonicalVariants(variants: ExperimentVariant[]): ManifestTest["variants"] {
  return [...variants]
    .sort((a, b) => byCodeUnit(String(a.id), String(b.id)))
    .map((v) => ({ id: v.id, weight: v.weight }));
}
