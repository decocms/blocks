/**
 * The content model: an A/B experiment as a saved block.
 *
 * ## Two names for one thing
 *
 * The saved block calls the test's identity `key`, because that is what Deco
 * Studio's Experiments tab calls it and what a site passes to
 * `useExperiment(key)`. The manifest the browser reads calls it `name`,
 * because that is the wire format the `deco-ab-testing` SDK already parses
 * and the string its assignment hash consumes. Renaming it on the wire would
 * re-bucket every visitor of every running test. `experimentManifest` is the
 * one place the two meet.
 */

/** One arm of an experiment. */
export interface ExperimentVariant {
  /**
   * The arm's id, as it appears in the assignment, in `data-ab-<key>` and in
   * the analytics `exp` map. Lowercase: see `NAME_PATTERN`.
   */
  id: string;
  /**
   * Share of traffic. The SDK normalises weights against their own total
   * rather than requiring them to sum to anything, so `{1, 1}`, `{50, 50}`
   * and `{0.5, 0.5}` all mean "half each" — the three ways a human writes it.
   */
  weight: number;
  /** Which side of the comparison this arm is. Metadata; assignment ignores it. */
  role?: "control" | "treatment";
  /** One sentence: what this arm shows or does. Metadata. */
  description?: string;
}

/** The saved block: one file per experiment under `.deco/blocks`. */
export interface Experiment {
  /** Stable identity. Changing it re-buckets every visitor — treat it as permanent. */
  key: string;
  /** Human-readable label for the CMS. Never reaches the browser. */
  name?: string;
  /** Off by default is wrong here: a saved experiment with no flag is live. */
  enabled?: boolean;
  variants?: ExperimentVariant[];
}

/** One test as the browser receives it. */
export interface ManifestTest {
  /** The experiment's `key`. Named `name` on the wire; see the note above. */
  name: string;
  enabled: boolean;
  variants: { id: string; weight: number }[];
}

/**
 * What a site serves to the browser. The shape is fixed by the
 * `deco-ab-testing` SDK already deployed on storefronts, so a site can swap
 * its endpoint from the Worker to its own content with no SDK change.
 *
 * EVERY VARIANT OF EVERY TEST, identical for every visitor: that is what lets
 * one cached copy serve everyone and keeps the page itself arm-neutral.
 */
export interface ExperimentManifest {
  tests: ManifestTest[];
}

/** The `__resolveType` a saved experiment carries, and what `client.list` takes. */
export const EXPERIMENT_TYPE = "experiment";

/**
 * The `experiment` block.
 *
 * A data block, like `page` and `redirect` — it returns what was saved, with
 * `enabled` defaulted. Nothing is decided here: which arm a visitor gets is
 * a property of the visitor, and this is content, shared by all of them.
 *
 * NOT A BUILT-IN, on purpose. The built-in set is nine blocks and the docs
 * say so (`/next/built-in-blocks`, pinned by `guides.test.ts`
 * qs-17/hiw-06/dd-03); experiments are a feature a site opts into, not part
 * of the core contract. A site registers it the way it registers any block:
 *
 * ```ts
 * import { experiment } from "@decocms/blocks/experiments";
 *
 * export const cms = createCMS({ blocks: { experiment, ...blocks }, content });
 * ```
 *
 * `deco schema` then derives the editor's form from {@link Experiment}, so
 * Studio gets the key, the arms and their weights with no schema written by
 * hand — and `deco check` validates saved experiments against it in CI.
 */
export const experiment = (props: Experiment): Experiment => ({
  ...props,
  // A saved experiment with no flag is live. The alternative — off until
  // someone ticks a box — means an operator who creates a test, wires the
  // arms and publishes sees no traffic and no reason why.
  enabled: props.enabled !== false,
  variants: props.variants ?? [],
});
