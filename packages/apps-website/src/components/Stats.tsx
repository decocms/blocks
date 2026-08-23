/**
 * Stats — deco's first-party analytics collector.
 *
 * Mount once in `__root.tsx`, alongside or instead of `<OneDollarStats />`:
 *
 * ```tsx
 * <DecoRootLayout … >
 *   <Stats />
 * </DecoRootLayout>
 * ```
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
 * ## Off by default
 *
 * `DECO_ANALYTICS_ENABLED` must be set to `true`. This is the inverse of
 * `ONEDOLLAR_ENABLED`, which defaults to on, and the asymmetry is deliberate: one is
 * the incumbent and the other is being introduced. The two gates are also
 * independent, so a site can run both during a shadow comparison and neither gate
 * can turn the other off.
 */

export interface Props {
	/**
	 * Where the collector is published. Empty means same-origin, which is the
	 * intended deployment: the script and the beacon are served from the site's own
	 * hostname so no third-party request is involved and nothing is blocked.
	 */
	origin?: string;
	/**
	 * The site's public key, for sites NOT served through our CDN.
	 *
	 * Sites behind our edge are identified by the `Host` header, which a visitor
	 * cannot forge; those must leave this unset. A key travels in the page source
	 * where anyone can read and reuse it, so a key-identified site is recorded with
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

/** Same-origin. See {@link Props.origin}. */
export const DEFAULT_ORIGIN = "";

/**
 * Opt-in, and independent of `ONEDOLLAR_ENABLED` so both can run at once.
 */
const DECO_ANALYTICS_ENABLED = process.env.DECO_ANALYTICS_ENABLED === "true";
const DECO_ANALYTICS_ORIGIN = process.env.DECO_ANALYTICS_ORIGIN;
const DECO_ANALYTICS_SITE_KEY = process.env.DECO_ANALYTICS_SITE_KEY;

function Stats({ origin, siteKey, defer, dev, debug }: Props) {
	if (!DECO_ANALYTICS_ENABLED) return null;

	const base = origin ?? DECO_ANALYTICS_ORIGIN ?? DEFAULT_ORIGIN;
	const key = siteKey ?? DECO_ANALYTICS_SITE_KEY;

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
				src={`${base}/_dq/a.js`}
				data-site={key}
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
