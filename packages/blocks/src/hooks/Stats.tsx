/**
 * Stats — deco's first-party analytics collector.
 *
 * MOUNTED BY THE FRAMEWORK. `DecoRootLayout` renders it, so a site turns analytics on with an
 * environment variable and no code change — the same ergonomics the Fresh side already has,
 * where `website/pages/Page.tsx` renders it for every page.
 *
 * It lives in `@decocms/blocks` rather than in `@decocms/apps-website` because of what it is:
 * twenty lines of a `<link>` and a `<script>` driven by environment variables, pointing at our
 * own collector. `OneDollarStats` belongs among the apps because it is a VENDOR integration —
 * it wraps `history`, decodes a cookie and feeds a third party\'s SDK. This is framework
 * infrastructure, and putting it here is also what lets `@decocms/tanstack` mount it without
 * importing from an apps package, which would be a new edge in a dependency graph the repo
 * keeps one-way on purpose.
 *
 * `@decocms/apps-website/components/Stats` re-exports it, so anything importing the old path
 * keeps working.
 *
 * ## Why this is twenty lines and OneDollarStats is three hundred
 *
 * Not because it does less — because the work is on the other side. The lilstts SDK
 * has no notion of SPA navigation the way this app routes, no notion of the
 * `deco_segment` cookie, and no notion of `window.DECO.events`, so the component has
 * to wrap `history.pushState`, poll for globals, read and decode the cookie, and
 * forward every commerce event by hand.
 *
 * The deco collector's own bundle already does all of it, and is tested doing it:
 * the core module takes the first pageview through the prerender guard, wraps
 * `pushState`, `replaceState` and `popstate`, and flushes on `pagehide` and
 * `visibilitychange`; the deco module reads `deco_segment` into experiment
 * assignments and subscribes to `window.DECO.events`, mapping the commerce
 * vocabulary. None of that belongs in a component that would then be a second
 * implementation of it, drifting from the first.
 *
 * So there is no `useEffect` here, and that is the point. Nothing to hydrate, no
 * readiness polling, no module-level guard against StrictMode double-mounting —
 * because there is no client state to guard.
 *
 * ## data- attributes, not a global
 *
 * `dev` and `debug` are read off the tag rather than from `window.__dq`, and this is
 * load-bearing on exactly this framework. TanStack hoists `<script async>` into
 * `<head>` ABOVE any inline configuration block — measured at byte 190 against byte
 * 1108 on a real site. A component that set a global and expected the collector to
 * find it would boot into silence here, with no error: the collector would see a
 * development host, skip, and say nothing. Attributes cannot lose that race because
 * they are on the element that is executing.
 *
 * ## Third-party by default
 *
 * The tag loads from the collector's origin and `DECO_ANALYTICS_SITE_KEY` identifies
 * the site. Without a key it renders nothing: on that origin nothing else identifies
 * the site, so its events would be dropped. `DECO_ANALYTICS_FIRST_PARTY=true` opts
 * into the site's own host, which must route `/_dq/*` to the collector.
 *
 * `DECO_ANALYTICS_ENABLED=false` turns it off. That gate and `ONEDOLLAR_ENABLED` are
 * independent, so a site can run both during a shadow comparison and neither can turn
 * the other off.
 */

export interface Props {
	/**
	 * Where the collector is published. Empty means same-origin: the script and the
	 * beacon are served from the site's own hostname, which must route `/_dq/*` to the
	 * collector.
	 */
	origin?: string;
	/**
	 * The site's public key, which identifies it on the collector's origin.
	 *
	 * First-party sites are identified by the `Host` header, which a visitor cannot
	 * forge; those must leave this unset. A key travels in the page source where anyone
	 * can read and reuse it, so a key-identified site is recorded with
	 * `site_id_source = tag` and is never billed from.
	 */
	siteKey?: string;
	/** `defer` instead of `async`. Only for a page that needs strict ordering. */
	defer?: boolean;
	/**
	 * Collect from localhost. The collector refuses local and private hostnames by
	 * default, which is why a developer sees nothing until this is on.
	 */
	dev?: boolean;
	/** Log every queued and flushed batch to the console. */
	debug?: boolean;
}

/** The collector's own origin. See {@link Props.origin}. */
export const DEFAULT_ORIGIN = "https://analytics.decocdn.com";

/**
 * On unless "false", and independent of `ONEDOLLAR_ENABLED` so both can run at once.
 */
function Stats({ origin, siteKey, defer, dev, debug }: Props) {
	// Read at render, not at import: the `@decocms/blocks/hooks` barrel reaches client bundles, and
	// `process` does not exist in a browser unless the bundler provides it.
	if (process.env.DECO_ANALYTICS_ENABLED === "false") return null;

	const base =
		origin ??
		process.env.DECO_ANALYTICS_ORIGIN ??
		(process.env.DECO_ANALYTICS_FIRST_PARTY === "true" ? "" : DEFAULT_ORIGIN);
	const key = siteKey ?? process.env.DECO_ANALYTICS_SITE_KEY;
	if (base === DEFAULT_ORIGIN && !key) return null;

	return (
		<>
			{/*
			 * Only when the collector is on another origin. A `preconnect` to the page's
			 * own origin is a wasted hint at best, and on some browsers it is a second
			 * connection opened for nothing.
			 */}
			{base ? <link rel="preconnect" href={base} crossOrigin="anonymous" /> : null}
			<script
				id="deco-analytics"
				async={!defer}
				defer={defer}
				// THE KEY GOES IN THE URL, not in a `data-` attribute. The collector resolves the
				// site server-side while RENDERING the bundle -- it reads `?k=` and writes the
				// resolved config into the script it returns -- so a key on the element arrives
				// far too late to matter. It is also never read: the bundle only looks at
				// `data-dev` and `data-debug`.
				//
				// This was `data-site` and it would have failed the way this project's failures
				// always do: the collector resolves nothing, serves the `s:"unknown"` fallback,
				// and the site collects exactly zero with no error anywhere. Same shape as the
				// bug that once made the entire self-serve tier silent.
				src={`${base}/_dq/a.js${key ? `?k=${encodeURIComponent(key)}` : ""}`}
				// Rendered only when true. `data-dev="false"` and an absent attribute mean
				// the same thing to the collector, and the absent one cannot be mistaken
				// for a deliberate setting by someone reading the page source.
				data-dev={dev ? "true" : undefined}
				data-debug={debug ? "true" : undefined}
			/>
		</>
	);
}

export default Stats;
