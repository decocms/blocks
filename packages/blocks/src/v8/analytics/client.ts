/**
 * `@decocms/blocks/analytics/client`: the Deco Analytics client for a v8 site,
 * without the external tag. It runs the same files decocms/analytics bundles
 * into `/_dq/a.js` (core, then each module), so identification, the queue,
 * the transport and the automatic collection have one implementation for both.
 *
 * Importing this module does nothing: no DOM access, safe on the server.
 * `startAnalytics()` does the work in the browser and never rejects, so a
 * failure is "analytics stopped", never "the page broke".
 */

/** The optional modules, by the names the collector's site config uses. */
export type AnalyticsModule =
  | "click"
  | "commerce"
  | "consent"
  | "deco"
  | "engagement"
  | "errors"
  | "heatmap"
  | "vitals";

export interface AnalyticsClientOptions {
  /** Modules to load after core, in this order. Default none: core alone collects page views. */
  modules?: AnalyticsModule[];
  /**
   * Where events go. Default `/_dq/e` on the page's own host, which is what makes the
   * collector resolve the site from the `Host` header, the only resolution billing trusts.
   */
  endpoint?: string;
  /** The site's declared key, for a host the collector can't resolve. Its events are `tag`-grade. */
  key?: string;
  /** Share of sheddable events to keep, 0 to 1. Core events (`$…`) are always kept. */
  sampling?: number;
  /** 1 lets the consent module keep a stable id once the visitor consents. Default 0. */
  tier?: 0 | 1;
  /** The site routes on `location.hash`, so a hash change is a page view. */
  hash?: boolean;
  /** Collect on a development host too (localhost, private ranges). */
  dev?: boolean;
  /** Heatmap module: share of page views it samples, 0 to 1. */
  heatmapRate?: number;
  /** Errors module: cross-origin script hosts that count as the site's own. */
  errorHosts?: string[];
  /**
   * The visitor's A/B tests as the page rendered them: each test of the saved `experiments`
   * block on or off, exactly the map that decided the page (on TanStack, what the worker
   * decided, `requestAssignments(request)?.experiments`). Every event then carries each test's
   * arm, `on` or `off`, in `exp`, the first page view included, and the collector stores it as
   * it stores any `exp`. Passing the decision rather than an id keeps what is measured equal to
   * what was shown, v7's kept decisions, a cached page and a release change included. Leave it
   * unset on a preview, whose switched tests are no visitor's.
   */
  experiments?: Readonly<Record<string, boolean>>;
}

/** The decided tests as the collector's `exp` values, `on` or `off`; non-boolean entries left out. */
function armsOf(
  experiments: Readonly<Record<string, boolean>> | undefined,
): Record<string, string> {
  const arms = Object.create(null) as Record<string, string>;
  if (typeof experiments !== "object" || experiments === null) return arms;
  for (const name of Object.keys(experiments)) {
    const on = experiments[name];
    if (typeof on === "boolean") arms[name] = on ? "on" : "off";
  }
  return arms;
}

/** One loader per file, so a bundler splits each module into its own chunk. */
const MODULES: Record<AnalyticsModule, () => Promise<unknown>> = {
  click: () => import("./runtime/modules/click.ts"),
  commerce: () => import("./runtime/modules/commerce.ts"),
  consent: () => import("./runtime/modules/consent.ts"),
  deco: () => import("./runtime/modules/deco.ts"),
  engagement: () => import("./runtime/modules/engagement.ts"),
  errors: () => import("./runtime/modules/errors.ts"),
  heatmap: () => import("./runtime/modules/heatmap.ts"),
  vitals: () => import("./runtime/modules/vitals.ts"),
};

/**
 * Starts collection in the browser: the page view now and on every client-side
 * navigation, plus whatever the modules collect. Call it once, after the page is
 * interactive; nothing visual should wait on it. Resolves to the client's API
 * (`track`, `pageview`, the modules' helpers such as `addToCart`), or null on the
 * server, when collection is off for this visitor (automation, opt-out, a
 * development host) or when anything failed.
 *
 * If the external tag already booted on this page, it is left alone and its API
 * is returned: one client per page, whichever came first.
 */
export async function startAnalytics(
  options: AnalyticsClientOptions = {},
): Promise<Record<string, unknown> | null> {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, any>;
  try {
    const arms = armsOf(options.experiments);
    if (w.__dqBooted) {
      // The tag booted first: its API is the client, so the arms go through it.
      if (typeof w.__dq?.track !== "function") return null;
      for (const name of Object.keys(arms)) w.__dq.setExperiment?.(name, arms[name]);
      return w.__dq;
    }

    // The same fields the collector writes ahead of `/_dq/a.js`, and the same precedence: what
    // the page already set on `window.__dq` wins. `q` is held back and replayed below, once
    // every module has registered: core replays its stub in a microtask, and a module in its
    // own chunk arrives later than that, so a helper queued before boot would be dropped.
    const page = (w.__dq ?? {}) as Record<string, unknown>;
    const queued = Array.isArray(page.q) ? [...page.q] : [];
    w.__dq = Object.assign(
      {
        s: "unknown",
        e: options.endpoint ?? "/_dq/e",
        r: options.sampling ?? 1,
        tier: options.tier ?? 0,
        ...(options.hash ? { hash: 1 } : {}),
        ...(options.dev ? { dev: true } : {}),
        ...(options.key ? { k: options.key } : {}),
        ...(options.heatmapRate !== undefined ? { hr: options.heatmapRate } : {}),
        ...(options.errorHosts?.length ? { er: options.errorHosts } : {}),
      },
      page,
      // The page's own map (another script's tests) is kept; on a name both carry, the arm the
      // page rendered wins. Set before core boots, so the first page view carries it.
      Object.keys(arms).length ? { x: { ...(page.x as object), ...arms } } : {},
      { q: [] },
    );

    await import("./runtime/src/index.ts");
    // Core assigns its API only when it collects; skipped means skipped, modules included.
    if (typeof w.__dq.track !== "function") return null;

    for (const name of new Set(options.modules ?? [])) await MODULES[name]?.();
    for (const r of queued) w.__dq.q?.push?.(r);
    return w.__dq;
  } catch {
    return null;
  }
}
