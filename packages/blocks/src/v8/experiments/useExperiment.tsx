"use client";

/**
 * Reading this visitor's arm from a component.
 *
 * ## Where the arm comes from
 *
 * The `deco-ab-testing` SDK. It fetches the manifest the site serves from
 * `.deco`, assigns the visitor, and publishes `window.__ab`. The decision
 * stays in the browser on purpose: a page whose HTML already holds the arm
 * has to be cached per arm, and five two-arm tests across three devices is
 * 96 cache entries per URL where there were 3. Deciding here keeps one
 * cached copy of the page for every visitor.
 *
 * The cost is that the arm is not known during the first render. `ready` is
 * `false` on the server and until the SDK resolves.
 *
 * ## Prefer CSS to this hook
 *
 * When an arm is expressible as styling — hiding, showing, reordering,
 * recolouring — key a plain CSS rule on `[data-ab-<key>="<arm>"]` and let the
 * SDK write that attribute on `<html>` before first paint. No JavaScript, no
 * flash, nothing for React to reconcile. Reach for the hook only when an arm
 * changes logic or markup CSS cannot express.
 *
 * ## The rule that keeps hydration honest
 *
 * The arm lands after an await, so reading it during render — at module
 * scope, in a `useState` initialiser, anywhere in the first pass — gives a
 * client render that disagrees with the server's HTML. React resolves that
 * mismatch by silently keeping the wrong arm on screen, which is an
 * experiment reporting treatment traffic that never saw the treatment. This
 * hook starts at the server's value and moves only inside an effect.
 *
 * It exists here because every site otherwise copies it: one storefront has
 * `useExperiment.ts` and `useABTest.ts` side by side, identical but for the
 * two names, because there was nowhere to import it from.
 */
import { useEffect, useState } from "react";

/** The arm a convention-following experiment calls its baseline. */
export const CONTROL_ARM = "control";

/** The slice of `window.__ab` this hook uses. */
interface AbApi {
  ready?: (cb: (api: AbApi) => void) => void;
  variant?: (test: string) => string | null;
}

function abApi(): AbApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __ab?: AbApi }).__ab;
}

export interface ExperimentResult {
  /**
   * The arm assigned to this visitor, or `null` when the experiment did not
   * apply: it is stopped, absent from the content, or this visitor fell
   * outside it. Also `null` while `ready` is false.
   */
  variant: string | null;
  /** True only for a real, non-control arm. `null` counts as the control. */
  isTreatment: boolean;
  /**
   * Whether the arm is known: `false` on the server and until the SDK
   * resolves in the browser.
   *
   * NEVER GATE THE FIRST RENDER ON IT. A component that renders nothing until
   * `ready` is a blank page for every visitor whose network is slow and for
   * every crawler. Render the control and let the treatment replace it.
   */
  ready: boolean;
}

/**
 * This visitor's arm for `key`.
 *
 * Don't call it with a literal at every call site — wrap it in a named hook
 * per experiment (`useBannerExperiment()`), so the key lives in one place and
 * a rename is one edit rather than a search.
 *
 * A key that matches no live experiment returns `null` and the control
 * renders. NOTHING CATCHES THAT MISMATCH TODAY: `deco check` validates saved
 * content, not the strings code passes here, so a typo is as silent as it was
 * when the configuration lived in KV — one storefront ran three dead tests
 * that way. Closing it needs the saved keys generated into a type this
 * signature can take.
 */
export function useExperiment(key: string): ExperimentResult {
  const [variant, setVariant] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const api = abApi();
    if (typeof api?.ready !== "function") {
      // No SDK on the page: resolve rather than wait for a callback that will
      // never come, so a consumer gating on `ready` is not stuck forever.
      setReady(true);
      return;
    }
    let live = true;
    api.ready((resolved) => {
      if (!live) return;
      setVariant(resolved.variant?.(key) ?? null);
      setReady(true);
    });
    // The SDK's queue has no unsubscribe, so this flag is what keeps a late
    // callback from setting state on an unmounted tree.
    return () => {
      live = false;
    };
  }, [key]);

  return { variant, isTreatment: variant !== null && variant !== CONTROL_ARM, ready };
}
