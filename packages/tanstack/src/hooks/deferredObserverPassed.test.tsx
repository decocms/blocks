import { describe, expect, it } from "vitest";

import { shouldLoadOnObservation } from "./DecoPageRenderer";

/**
 * Guards the "reader is already past the section" branch of
 * `DeferredSectionWrapper`'s IntersectionObserver callback.
 *
 * `IntersectionObserver` fires on ENTERING. The observer is attached one frame
 * after hydration (see `deferredObserverTiming.test.tsx` for why), and at that
 * moment the reader is not necessarily at the top of the document: browser
 * scroll restoration on reload, back/forward, an `#anchor`, or a programmatic
 * `scrollTo` all land below the fold. A deferred section left above the
 * viewport then receives exactly one callback with `isIntersecting: false` and
 * never fires again while the reader keeps going down — it stays a skeleton
 * for the whole visit.
 *
 * Measured on a storefront `/prime` before the fix: landing at `y=5200` with
 * the product shelf at 3164–3829 left the shelf empty at 8s, 43s and 83s, and
 * it only filled after scrolling back up into it.
 *
 * jsdom has no layout and never fires a real IntersectionObserver, so this
 * asserts the decision directly rather than rendering the component.
 */
const rect = (bottom: number) => ({ bottom });

describe("deferred observer — section already scrolled past", () => {
  it("loads a section left above the viewport", () => {
    // Reader reloaded below it; the element is entirely above the fold.
    expect(shouldLoadOnObservation({ isIntersecting: false, boundingClientRect: rect(-400) })).toBe(
      true,
    );
  });

  it("loads a section in view", () => {
    expect(shouldLoadOnObservation({ isIntersecting: true, boundingClientRect: rect(500) })).toBe(
      true,
    );
  });

  it("does NOT load a section still below the viewport", () => {
    // The normal case deferral exists for — must keep waiting for the scroll,
    // otherwise every below-the-fold section fires its POST on mount.
    expect(shouldLoadOnObservation({ isIntersecting: false, boundingClientRect: rect(2400) })).toBe(
      false,
    );
  });

  it("does NOT load a section sitting exactly at the viewport top", () => {
    // bottom === 0 is the boundary: nothing of it is visible yet, but it has
    // not been passed either. `rootMargin: 300px` means the real observer
    // already reports this one as intersecting, so the predicate must not
    // double-count it as passed.
    expect(shouldLoadOnObservation({ isIntersecting: false, boundingClientRect: rect(0) })).toBe(
      false,
    );
  });
});
