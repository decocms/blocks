/**
 * Build-time manifest of A/B tests (`.deco/TestesAB.json` in a consuming
 * site), consulted by `useExperiment` (`./useExperiment.ts`).
 *
 * This manifest is METADATA ONLY — which tests exist, their possible
 * variants, and whether they're currently active. It never holds the
 * per-visitor ASSIGNMENT (which arm a given visitor got); that still comes
 * from the `window.__ab` API installed by the `deco-ab-testing` Worker's
 * script at runtime, because assignment is inherently per-request/per-visitor
 * state that can't be baked into a static build artifact.
 *
 * What the manifest buys `useExperiment`: for a test that's absent or
 * inactive, the server and the client agree on that fact from the exact same
 * bundled JSON — no round trip to `window.__ab` needed, and critically no
 * asymmetry between the server-rendered HTML and the first client render (the
 * two class of bug this whole module exists to avoid; see the hydration-
 * mismatch note in `useExperiment.ts`).
 *
 * Read at BUILD TIME, not runtime: a site imports the JSON file as a module
 * (`import testesAB from "../.deco/TestesAB.json"`, Vite/tsc's
 * `resolveJsonModule` inlines it into the bundle) and passes it to
 * `createSiteSetup({ experiments: testesAB, ... })` (`../setup.ts`), which
 * calls `setExperimentManifest` for you. Updating the file requires a
 * rebuild/redeploy — same tradeoff as `.deco/blocks.gen`, and deliberate:
 * unlike the KV-backed Fast Deploy path for content, experiment definitions
 * are not something that should flip live without a deploy.
 */

export interface ExperimentConfig {
  /** All possible arm names this test can resolve to, including "control". */
  variants: string[];
  /**
   * Whether the test is currently running. `useExperiment` treats a missing
   * entry the same as `active: false` — both mean "we already know, without
   * asking `window.__ab`, that this visitor gets no variant."
   */
  active: boolean;
}

export type ExperimentManifest = Record<string, ExperimentConfig>;

// globalThis-backed storage, same rationale as `setBlocks`/`blockData` in
// `../cms/loader.ts`: TanStack Start server-function code-splitting can load
// this module more than once in the same isolate, so state lives on
// globalThis rather than a plain module-scope variable to stay shared.
const G = globalThis as any;
if (!G.__deco) G.__deco = {};

let manifest: ExperimentManifest = G.__deco.experimentManifest ?? {};

/**
 * Register the experiment manifest. Called once at site boot — see
 * `createSiteSetup`'s `experiments` option — with both server and client
 * calling it (unlike `setBlocks`, which is server-only): `useExperiment`
 * needs the same manifest on both sides to size up a test before its first
 * render.
 */
export function setExperimentManifest(next: ExperimentManifest): void {
  manifest = next;
  G.__deco.experimentManifest = manifest;
}

/** The full manifest currently registered, or `{}` before `setExperimentManifest` runs. */
export function getExperimentManifest(): ExperimentManifest {
  return G.__deco.experimentManifest ?? manifest;
}

/** The manifest entry for one test, or `undefined` if it's unknown. */
export function getExperimentConfig(test: string): ExperimentConfig | undefined {
  return getExperimentManifest()[test];
}
