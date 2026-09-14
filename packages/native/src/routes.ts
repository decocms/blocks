/**
 * Route policy: which CMS pages the app renders natively, and which it hands
 * to a WebView.
 *
 * ## Why this is generated, not injected
 *
 * The page tree is already data — `.deco/blocks/pages-*.json`, the same files
 * Studio writes. So "declare routes once" is a codegen problem, not a reason to
 * ship a second router. That matters concretely because CMS paths are
 * **URLPattern** syntax and `matchPath` (`@decocms/blocks`) *throws* on a
 * runtime without the `URLPattern` API — which Hermes is. The generator runs in
 * Node, which has it, and emits plain regexes the device can run.
 *
 * ## WebView is the default, and that is load-bearing
 *
 * The generated table is a snapshot of the CMS at build time. The app is a
 * released binary; a page published tomorrow is not in it. So an unmatched path
 * must fall through to the WebView, never 404 — otherwise publishing in Studio
 * breaks the app until the next store release, and the whole point of being
 * CMS-driven dies.
 *
 * What reflects with no build: content, and brand-new pages (via WebView).
 * What needs a build: a new *section type*, because that needs a native
 * renderer.
 */

/** One CMS page, as compiled by `--platform native`. */
export interface CmsRoute {
  /** The decofile path, in URLPattern syntax: `/products/:slug`. */
  path: string;
  /** Page name, for debugging and screen titles. */
  name: string;
  /** Param names, in the order they appear. */
  params: string[];
  /**
   * Compiled matcher. Source strings rather than literals so the generated
   * file stays plain data.
   */
  pattern: string;
}

export interface RouteMatch {
  route: CmsRoute;
  params: Record<string, string>;
}

/** Finds the CMS page that serves a path. Routes are pre-sorted by specificity. */
export function matchCmsRoute(routes: CmsRoute[], pathname: string): RouteMatch | null {
  const clean = pathname.split(/[?#]/)[0] || "/";
  for (const route of routes) {
    const found = new RegExp(route.pattern).exec(clean);
    if (!found) continue;
    const params: Record<string, string> = {};
    route.params.forEach((name, i) => {
      const value = found[i + 1];
      if (value !== undefined) params[name] = decodeURIComponent(value);
    });
    return { route, params };
  }
  return null;
}

export interface RoutePolicyOptions {
  /** The generated table. */
  routes: CmsRoute[];
  /**
   * CMS path → app route, for the pages that have native screens.
   * Keys are the decofile paths verbatim (`"/"`, `"/products/:slug"`).
   * Everything absent stays in the WebView — that is the whole opt-in.
   */
  native: Record<string, string>;
  /**
   * Builds the WebView route for a site path.
   * @default `/web/${encodeURIComponent(path without leading slash)}`
   */
  webRoute?: (path: string) => string;
}

export type RouteTarget =
  | { kind: "native"; route: string; params: Record<string, string>; page: CmsRoute }
  | { kind: "web"; route: string };

/**
 * Turns a site path into an app route.
 *
 * Every `href` coming from CMS content should go through this. Sections then
 * never learn what is native — registering a new native screen changes the
 * behavior of every section that already linked there, at once.
 */
export function createRoutePolicy(options: RoutePolicyOptions) {
  const { routes, native } = options;
  const webRoute =
    options.webRoute ?? ((path: string) => `/web/${encodeURIComponent(path.replace(/^\//, ""))}`);

  function resolve(href: string): RouteTarget {
    // CMS `url` fields are absolute and carry the server's host.
    let path = href;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
      try {
        const url = new URL(href);
        path = url.pathname + url.search;
      } catch {
        // Unparseable — treat it as a path and let the WebView deal with it.
      }
    }

    const match = matchCmsRoute(routes, path);
    const target = match ? native[match.route.path] : undefined;

    if (match && target) {
      // Substitutes `[slug]`/`:slug` in the target with the matched params.
      const filled = Object.entries(match.params).reduce(
        (acc, [key, value]) =>
          acc
            .replace(`[${key}]`, encodeURIComponent(value))
            .replace(`:${key}`, encodeURIComponent(value)),
        target,
      );
      return { kind: "native", route: filled, params: match.params, page: match.route };
    }

    // Unmatched, or matched but not opted in: the WebView. Never a 404 — the
    // page may have been published after this binary was built.
    return { kind: "web", route: webRoute(path) };
  }

  return { resolve, match: (path: string) => matchCmsRoute(routes, path) };
}

export type RoutePolicy = ReturnType<typeof createRoutePolicy>;
