/**
 * Speculation Rules API helper.
 *
 * Builds the JSON for a `<script type="speculationrules">` tag so the browser
 * prerenders (or prefetches) the next document ahead of a real navigation,
 * making it feel instant. This only helps *document* navigations — raw `<a>`
 * links that leave the SPA (mega-menu → category, footer → institutional).
 * Client-routed `<Link>`s are intercepted by the router and never benefit, so
 * scope the candidates to the elements that actually do hard navigations via
 * `linkSelector` (e.g. a header/menu container marked `[data-prerender]`).
 *
 * Ships DISABLED: `DecoRootLayout` emits nothing unless a site passes a
 * `speculationRules` config. Activate per-site only once the site's own
 * analytics/pixel loaders are prerender-guarded (see ANALYTICS_SCRIPT /
 * gtmScript in @decocms/blocks/sdk/analytics), otherwise a prerender that
 * never activates can double-count pageviews.
 *
 * @see https://developer.chrome.com/docs/web-platform/prerender-pages
 */

import { htmlSafeJson } from "@decocms/blocks/sdk/htmlSafe";

export type SpeculationAction = "prerender" | "prefetch";

/**
 * How aggressively the browser speculates:
 * - `immediate`  — as soon as the rule is seen (use sparingly).
 * - `eager`      — on the smallest hint of interaction.
 * - `moderate`   — on hover (~200ms) / pointerdown. Good default for menus.
 * - `conservative` — on pointerdown only (cheapest; dial down to this if
 *   speculative server load gets high).
 */
export type SpeculationEagerness =
  | "immediate"
  | "eager"
  | "moderate"
  | "conservative";

export interface SpeculationRulesConfig {
  /**
   * `prerender` (instant nav, runs the page's JS in a hidden document — requires
   * prerender-safe analytics) or `prefetch` (cheaper, fetches the HTML only, no
   * JS execution). Default: `"prerender"`.
   */
  action?: SpeculationAction;
  /** Default: `"moderate"`. */
  eagerness?: SpeculationEagerness;
  /**
   * CSS selector for candidate anchors. Restricts speculation to hard-navigation
   * links and excludes client-routed `<Link>`s by construction.
   * Example: `"[data-prerender] a[href]"`. When omitted, all same-origin
   * internal links (`/*`) are candidates.
   */
  linkSelector?: string;
  /**
   * Extra pathname URLPattern strings to exclude, merged with the built-in
   * stateful/proxy exclusions. Example: `["/*\/p"]` to skip PDPs.
   */
  excludeHrefMatches?: string[];
  /**
   * Replace the built-in stateful/proxy exclusions instead of extending them.
   * Only set this if you know none of the default-excluded paths exist.
   * Default: `false` (keep the safe defaults).
   */
  overrideDefaultExclusions?: boolean;
}

/**
 * Paths that are unsafe or wasteful to speculatively load: stateful/auth pages
 * (session side effects) and typical proxied/API routes (uncacheable, fresh-0).
 * Mirrors the `private` cache profile.
 */
export const DEFAULT_EXCLUDED_HREF_MATCHES: readonly string[] = [
  "/checkout*",
  "/account*",
  "/_secure/*",
  "/login*",
  "/logout*",
  "/cart*",
  "/api/*",
];

type WhereCondition =
  | { href_matches: string }
  | { selector_matches: string }
  | { not: WhereCondition }
  | { and: WhereCondition[] };

/**
 * Builds the JSON string for a `<script type="speculationrules">` tag from a
 * typed config. Safe stateful/proxy exclusions are baked in by default.
 */
export function buildSpeculationRules(config: SpeculationRulesConfig = {}): string {
  const {
    action = "prerender",
    eagerness = "moderate",
    linkSelector,
    excludeHrefMatches = [],
    overrideDefaultExclusions = false,
  } = config;

  const exclusions = overrideDefaultExclusions
    ? excludeHrefMatches
    : [...DEFAULT_EXCLUDED_HREF_MATCHES, ...excludeHrefMatches];

  const conditions: WhereCondition[] = [
    linkSelector
      ? { selector_matches: linkSelector }
      : { href_matches: "/*" },
    ...exclusions.map((href) => ({ not: { href_matches: href } } as WhereCondition)),
  ];

  return htmlSafeJson({
    [action]: [{ where: { and: conditions }, eagerness }],
  });
}

// ---------------------------------------------------------------------------
// Site-level activation (module singleton)
//
// Set once at worker init via `createDecoWorkerEntry({ speculationRules })` —
// same lifecycle and isolate as setRenderShell — and read at SSR render time by
// DecoRootLayout. This is why activation lives in the worker-entry options
// (like `asJson` / `renderJson`) while the tag is still rendered in the HTML
// (cache-safe) instead of injected at the edge. Ships DISABLED (undefined).
// ---------------------------------------------------------------------------

let activeConfig: SpeculationRulesConfig | undefined;

/** Enable Speculation Rules site-wide. Called by createDecoWorkerEntry. */
export function setSpeculationRules(config: SpeculationRulesConfig | undefined): void {
  activeConfig = config;
}

/** Current site-wide Speculation Rules config, or undefined when disabled. */
export function getSpeculationRules(): SpeculationRulesConfig | undefined {
  return activeConfig;
}
