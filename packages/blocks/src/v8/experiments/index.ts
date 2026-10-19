/**
 * `@decocms/blocks/experiments`: A/B experiment configuration as content.
 *
 * An experiment is a saved block under `.deco/blocks` — versioned, previewed
 * as a draft, published with a release and checked in CI, like everything
 * else the CMS owns. It replaces a document in a Workers KV namespace that
 * nothing in the site's repository could see.
 *
 * What moves is the *configuration*. Who gets which arm is still decided by
 * the `deco-ab-testing` SDK in the browser: a page whose HTML holds the arm
 * must be cached per arm, while the manifest is one document, identical for
 * every visitor, so it caches as one copy and the page stays arm-neutral.
 *
 * The site registers the block, then serves `experimentManifest`'s output at
 * its own endpoint and points the SDK's `data-endpoint` at it. Build it once
 * per `client.revision()`: `list` walks and expands every saved block.
 *
 * Not in here, deliberately: no assignment (the SDK's job — this package
 * owns only the arms' *order*, since the SDK walks them as given), no
 * cookies or HTTP, no KV, no network, no environment reads.
 */
export {
  EXPERIMENT_TYPE,
  type Experiment,
  type ExperimentManifest,
  type ExperimentVariant,
  experiment,
  type ManifestTest,
} from "./experiment.ts";
export {
  type BuiltManifest,
  type ExperimentError,
  type ExperimentProblem,
  experimentManifest,
  LIMITS,
  NAME_PATTERN,
  type SkippedExperiment,
  validateExperiment,
} from "./manifest.ts";
