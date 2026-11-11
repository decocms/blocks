// The seam optional modules attach through. Declared once, ambiently, so a module does
// not have to redeclare `window` as `any` just to reach it — which is what commerce.ts
// did, and it disabled every other type check in the file as a side effect.
interface Window {
  __dqRegister?: (
    fn: (
      enqueue: EnqueueFn,
      api: Record<string, unknown>,
      /** Register work to run just BEFORE the last flush of a page load. A module that
       *  only knows its value at the end — scroll depth, the vitals, accumulated error
       *  repeats — contributes here rather than spending a request of its own. */
      onFinal: (hook: () => void) => void,
      /** Register work to run when an SPA navigation changes the URL, BEFORE the new
       *  `$pageview`, with the path being left. A per-view measurement closes its view here. */
      onRoute: (hook: (prev: string) => void) => void,
    ) => void,
  ) => void;
  __dq?: Record<string, unknown>;
  __dqAllowAutomation?: boolean;
  /** Set by `boot()` so a second copy of this bundle on the same page does nothing. Two
   *  identical script tags both execute -- the browser reuses the cached resource, not the
   *  execution -- and that is two pageviews for one page load. */
  __dqBooted?: boolean;
}

type EnqueueFn = (
  name: string,
  props?: Record<string, string | number | boolean>,
  extra?: Record<string, unknown>,
  /** Send this event NOW instead of letting it batch. The module that owns an event is the
   *  only thing that can judge what losing it costs, and core must not learn event names to
   *  decide -- a name check in core put the word "purchase" in the bundle served to sites
   *  that do not have the commerce module. Costs one request, so it is for events whose loss
   *  is not recoverable from anything else: `purchase`, and so far nothing else. */
  urgent?: boolean,
) => void;
