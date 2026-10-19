/**
 * `@decocms/blocks/experiments`: reading a visitor's A/B arm.
 *
 * The `deco-ab-testing` SDK assigns in the browser and publishes
 * `window.__ab`; {@link useExperiment} is how a component reads it without
 * re-deriving the hydration rules every time. The decision stays client-side
 * on purpose: a page whose HTML already holds the arm has to be cached per
 * arm, while an arm-neutral page is one cached copy for every visitor.
 *
 * Prefer a CSS rule on `[data-ab-<key>="<arm>"]` wherever an arm is styling —
 * the SDK writes that attribute before first paint, so it costs no
 * JavaScript. Reach for the hook only when an arm changes logic or markup
 * CSS cannot express.
 */
export { CONTROL_ARM, type ExperimentResult, useExperiment } from "./useExperiment.tsx";
