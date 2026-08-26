import { act, useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

/**
 * Guards the frame gate in `DeferredSectionWrapper`'s IntersectionObserver
 * effect (`DecoPageRenderer.tsx`).
 *
 * Enabling deferral on client navigation made a latent ordering problem
 * reachable. On a SPA transition the scroll position is still wherever the user
 * left the previous page when the new page's skeletons mount. TanStack resets it
 * from the `onRendered` event, emitted by a `useLayoutEffect` in react-router's
 * `OnRendered` that depends on the `resolvedLocation` store — which is itself
 * written from another `useLayoutEffect` (`Transitioner`). The reset therefore
 * lands one commit AFTER the mount commit, and React flushes the mount commit's
 * passive effects before starting that follow-up render.
 *
 * Net effect without a gate: the observer evaluates intersection against the
 * stale offset, so a user navigating from the bottom of a long page has every
 * skeleton in view simultaneously and every deferred section fires its serverFn
 * POST at once — the thundering herd deferral exists to avoid.
 *
 * This models that exact effect topology rather than mounting the real router,
 * because the ordering is a property of React's commit/flush sequence, not of
 * TanStack. If React ever changes it so passive effects run after a
 * layout-effect-triggered re-render, the first case flips and the gate can go.
 */
function runOrdering(gate: "none" | "raf") {
  const order: string[] = [];

  /** Stands in for TanStack's Transitioner writing `resolvedLocation`. */
  function Transitioner({ setResolved }: { setResolved: (n: number) => void }) {
    useLayoutEffect(() => setResolved(1), [setResolved]);
    return null;
  }

  /** Stands in for `OnRendered` → `onRendered` → scroll-restoration reset. */
  function OnRendered({ resolved }: { resolved: number }) {
    useLayoutEffect(() => {
      if (resolved > 0) order.push("SCROLL_RESET");
    }, [resolved]);
    return null;
  }

  /** Stands in for DeferredSectionWrapper's observer effect. */
  function DeferredWrapper() {
    useEffect(() => {
      const observe = () => order.push("OBSERVE");
      if (gate === "none") {
        observe();
        return;
      }
      const raf = requestAnimationFrame(observe);
      return () => cancelAnimationFrame(raf);
    }, []);
    return null;
  }

  function App() {
    const [resolved, setResolved] = useState(0);
    return (
      <>
        {/* Deliberately first: children flush before the root's own effects. */}
        <DeferredWrapper />
        <Transitioner setResolved={setResolved} />
        <OnRendered resolved={resolved} />
      </>
    );
  }

  const el = document.createElement("div");
  document.body.appendChild(el);
  act(() => {
    createRoot(el).render(<App />);
  });
  return order;
}

describe("deferred observer vs router scroll reset", () => {
  it("observing synchronously loses the race — this is why the gate exists", () => {
    // If this ever reports SCROLL_RESET first, React's flush order changed and
    // the requestAnimationFrame gate in DecoPageRenderer is dead weight.
    expect(runOrdering("none")).toEqual(["OBSERVE", "SCROLL_RESET"]);
  });

  it("one frame is enough for the scroll reset to land first", () => {
    // rAF does not run inside act(), so the reset is the only thing recorded —
    // i.e. observation is strictly after it, which is the point.
    expect(runOrdering("raf")).toEqual(["SCROLL_RESET"]);
  });
});
