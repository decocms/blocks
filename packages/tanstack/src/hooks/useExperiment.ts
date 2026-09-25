import { useEffect, useState } from "react";

/**
 * Base hook for the `window.__ab` API installed by the A/B testing SDK
 * (`deco-ab-testing` Worker, loaded via a blocking `<script>` tag in the
 * site's root layout — locally that's typically
 * `http://127.0.0.1:8788/_ab/s.js` with `data-dev="true"`, in production
 * `https://deco-ab-testing.deco-cx.workers.dev/_ab/s.js`).
 *
 * Prefer a CSS attribute (`data-ab-<test>`) when a test only needs to
 * hide/show something — it applies before first paint and survives
 * hydration untouched. Reach for this hook only when the variant changes
 * actual logic or markup CSS can't express, e.g. swapping a color that's
 * itself CMS-driven data, or rendering a different component tree.
 *
 * Don't call this directly in a component — wrap it in a named hook per
 * experiment (site-local, next to the site's other A/B tests) so the test
 * name lives in one place and the component reads like
 * `useBlackButtonOffExperiment()`.
 */

type ABApi = {
  ready: (cb: (api: ABApi) => void) => void;
  variant: (test: string) => string | null;
  id?: string | null;
  assignments?: Record<string, string>;
};
type Win = typeof globalThis & { __ab?: ABApi };

export type ExperimentResult = {
  /** False on the server and until the manifest resolves client-side. */
  ready: boolean;
  /** The arm assigned to this visitor, or null: test stopped, absent from
   *  the manifest, or this visitor fell outside it. */
  variant: string | null;
  /** True only once a real, non-control arm is known. Convention shared
   *  with the rest of the fleet: the control arm is always named "control". */
  isTreatment: boolean;
};

export function useExperiment(test: string): ExperimentResult {
  // Always mount at `null`/`ready: false`, even though the blocking SDK tag
  // may have already resolved the assignment synchronously by the time this
  // runs (e.g. a forced `?__ab=test:arm` QA link needs no manifest fetch).
  // Reading `window.__ab.variant(test)` in the initializer instead makes the
  // FIRST CLIENT RENDER disagree with the server-rendered (always-null) HTML
  // — a hydration mismatch. React logs it and, seeing a mismatch, does not
  // patch the affected attributes on that commit. Since nothing schedules a
  // later render once state and the (already-current) `ready()` value agree,
  // the wrong (server) styling stays on screen forever, silently. Starting
  // `null` here guarantees the `ready()` callback below is the one and only
  // place state moves away from it, producing a real update, not a
  // hydration diff.
  const [variant, setVariant] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const api = (window as Win).__ab;
    if (!api?.ready) {
      // No SDK on the page at all — don't wait forever for a callback that
      // will never fire.
      setReady(true);
      return;
    }
    api.ready((resolvedApi) => {
      setVariant(resolvedApi.variant(test));
      setReady(true);
    });
  }, [test]);

  return { ready, variant, isTreatment: variant !== null && variant !== "control" };
}
