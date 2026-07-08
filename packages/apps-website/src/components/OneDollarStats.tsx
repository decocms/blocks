/**
 * OneDollarStats — deco's lightweight in-house analytics.
 *
 * Posts pageviews (initial load + SPA navigations) and forwards DECO
 * events to the lilstts collector. Mount once in `__root.tsx` as a child
 * of `DecoRootLayout`:
 *
 * ```tsx
 * <DecoRootLayout … >
 *   <OneDollarStats />
 * </DecoRootLayout>
 * ```
 *
 * The component is env-gated and self-mounting — no CMS wiring needed.
 *
 * ## Why this design
 *
 * 1. **We own pageviews.** The lilstts SDK has its own auto-pageview path
 *    (driven by `history.pushState` wrapping). We disable it via
 *    `data-autocollect="false"` and call `window.stonks.view(flags)`
 *    ourselves. This is the only way to attach `deco_segment` cookie
 *    flags to pageviews — the SDK's auto-path doesn't know about them.
 *
 * 2. **`useEffect` for client logic.** All side-effects (initial pageview,
 *    pushState wrap, DECO event subscribe) run inside a `useEffect`,
 *    which fires after hydration. By then `<ScriptOnce>` in
 *    `DecoRootLayout` has bootstrapped `window.DECO.events`, and the SDK
 *    `<script>` (rendered as a sibling) has loaded and set
 *    `window.stonks`. No inline `dangerouslySetInnerHTML` snippet, no
 *    fragile script-execution-order dependency.
 *
 * 3. **Module-level guards.** `window.DECO.events.subscribe()` returns no
 *    unsubscribe handle, so we cannot clean up on unmount. We use a
 *    module-level `initialized` flag to ensure init runs exactly once
 *    per page lifetime, surviving HMR and React StrictMode double-mount.
 *
 * 4. **Bounded readiness polling.** `window.stonks` and `window.DECO`
 *    might not be ready the instant our effect fires (race with script
 *    load). We poll every 50 ms for up to 10 s. Production: resolves
 *    within one tick.
 *
 * ## Behavioural parity vs Fresh `deco-cx/apps`
 *
 * Mirrors the Path B snippet (`analytics/loaders/OneDollarScript.ts`):
 * unconditional first pageview with flag enrichment, SPA nav tracking,
 * and DECO event forwarding. Diverges from the Fresh component variant
 * (which depended on a synthesised `{ name: "deco" }` event from
 * `Events.tsx`'s subscribe-replay — no equivalent in TanStack).
 *
 * `pageId` enrichment is intentionally dropped — no admin dashboard
 * consumes it. Add later if a flag-segmented dashboard needs it.
 */

import { useEffect } from "react";

declare global {
	interface Window {
		stonks?: {
			view?: (params?: Record<string, string | boolean | number>) => void;
			event?: (name: string, params?: Record<string, string | boolean | number>) => void;
		};
	}
}

export interface Props {
	/** lilstts collector URL. Defaults to {@link DEFAULT_COLLECTOR_ADDRESS}. */
	collectorAddress?: string;
	/** lilstts static script URL. Defaults to {@link DEFAULT_ANALYTICS_SCRIPT_URL}. */
	staticScriptUrl?: string;
}

export const DEFAULT_COLLECTOR_ADDRESS = "https://d.lilstts.com/events";
export const DEFAULT_ANALYTICS_SCRIPT_URL = "https://s.lilstts.com/deco.js";

/**
 * Set `ONEDOLLAR_ENABLED=false` on the Worker to disable. Default: enabled.
 * Matches the Fresh-side Deno env contract.
 */
const ONEDOLLAR_ENABLED = process.env.ONEDOLLAR_ENABLED !== "false";
const ONEDOLLAR_COLLECTOR = process.env.ONEDOLLAR_COLLECTOR;
const ONEDOLLAR_STATIC_SCRIPT = process.env.ONEDOLLAR_STATIC_SCRIPT;

function OneDollarStats({ collectorAddress, staticScriptUrl }: Props) {
	if (!ONEDOLLAR_ENABLED) return null;

	const collector = collectorAddress ?? ONEDOLLAR_COLLECTOR ?? DEFAULT_COLLECTOR_ADDRESS;
	const staticScript = staticScriptUrl ?? ONEDOLLAR_STATIC_SCRIPT ?? DEFAULT_ANALYTICS_SCRIPT_URL;

	return (
		<>
			<link rel="dns-prefetch" href={collector} />
			<link rel="preconnect" href={collector} crossOrigin="anonymous" />
			<script
				id="onedollarstats-tracker"
				data-autocollect="false"
				data-hash-routing="true"
				data-url={collector}
				src={staticScript}
				defer
			/>
			<OneDollarStatsClient />
		</>
	);
}

/**
 * Client-only side-effects. Mounted as a child of {@link OneDollarStats};
 * does not render any DOM.
 */
function OneDollarStatsClient() {
	useEffect(() => {
		initOneDollarStats();
	}, []);
	return null;
}

// ---------------------------------------------------------------------------
// Module-level state — survives StrictMode double-mount and HMR remounts.
// ---------------------------------------------------------------------------

let initialized = false;
let cachedFlags: Record<string, boolean> | null = null;

interface DecoSegmentCookie {
	active?: string[];
	inactiveDrawn?: string[];
}

/**
 * Read A/B test flags from the `deco_segment` cookie. Cached after first
 * read for the lifetime of the page — flags are baked at request time
 * server-side and don't change mid-session.
 *
 * Exported for testing.
 */
export function readFlagsFromCookie(
	cookieString: string = typeof document !== "undefined" ? document.cookie : "",
): Record<string, boolean> {
	if (cachedFlags && cookieString === (typeof document !== "undefined" ? document.cookie : "")) {
		return cachedFlags;
	}
	const flags: Record<string, boolean> = {};
	try {
		const cookies = parseCookies(cookieString);
		const raw = cookies.deco_segment;
		if (raw) {
			const seg = JSON.parse(decodeURIComponent(atob(raw))) as DecoSegmentCookie;
			for (const name of seg.active ?? []) flags[name] = true;
			for (const name of seg.inactiveDrawn ?? []) flags[name] = false;
		}
	} catch {
		// Malformed cookie — proceed with empty flags rather than crashing analytics.
	}
	cachedFlags = flags;
	return flags;
}

function parseCookies(cookieString: string): Record<string, string> {
	return cookieString.split(";").reduce<Record<string, string>>((acc, c) => {
		const idx = c.indexOf("=");
		if (idx > 0) acc[c.slice(0, idx).trim()] = c.slice(idx + 1).trim();
		return acc;
	}, {});
}

/**
 * Truncate any value to the lilstts payload limit (~1 KB per field).
 * Exported for testing.
 */
export function truncate(v: unknown): string {
	const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
	return s.slice(0, 990);
}

/**
 * Poll for a global to become available, then invoke `cb` exactly once.
 * Bounded by `maxAttempts * intervalMs` (default ~10 s). On timeout, no-op.
 */
function whenReady<T>(
	check: () => T | undefined,
	cb: (value: T) => void,
	{ intervalMs = 50, maxAttempts = 200 }: { intervalMs?: number; maxAttempts?: number } = {},
): void {
	const initial = check();
	if (initial !== undefined) {
		cb(initial);
		return;
	}
	let attempts = 0;
	const iv = setInterval(() => {
		attempts++;
		const v = check();
		if (v !== undefined) {
			clearInterval(iv);
			cb(v);
		} else if (attempts >= maxAttempts) {
			clearInterval(iv);
		}
	}, intervalMs);
}

/**
 * Wire up the analytics integration. Idempotent — only the first call has
 * any effect.
 *
 * @internal exported for tests; do not call from app code.
 */
export function initOneDollarStats(): void {
	if (initialized) return;
	initialized = true;

	const flags = readFlagsFromCookie();

	// 1) Initial pageview + SPA nav tracking, with flag enrichment.
	whenReady(
		() =>
			typeof window.stonks?.view === "function"
				? window.stonks.view.bind(window.stonks)
				: undefined,
		(view) => {
			view(flags);
			wrapHistoryPushState(() => view(flags));
			addEventListener("popstate", () => view(flags));
		},
	);

	// 2) Forward DECO events to stonks.event with flag enrichment.
	whenReady(
		() =>
			typeof window.DECO?.events?.subscribe === "function"
				? window.DECO.events.subscribe.bind(window.DECO.events)
				: undefined,
		(subscribe) => {
			subscribe((event: { name?: string; params?: Record<string, unknown> } | null | undefined) => {
				if (!event || !event.name || event.name === "deco") return;
				if (typeof window.stonks?.event !== "function") return;
				const values: Record<string, string | boolean | number> = { ...flags };
				for (const [k, v] of Object.entries(event.params ?? {})) {
					if (v == null) continue;
					values[k] = truncate(v);
				}
				window.stonks.event(event.name, values);
			});
		},
	);
}

/**
 * Wrap `history.pushState` to invoke `onPush` after each call. Idempotent
 * via a marker property on the wrapper. The lilstts SDK installs its own
 * wrapper too — with `data-autocollect="false"` its handler is a no-op,
 * so we don't double-fire.
 */
function wrapHistoryPushState(onPush: () => void): void {
	const ANY_HISTORY = history as History & { __onedollarstats_wrapped?: true };
	if (ANY_HISTORY.__onedollarstats_wrapped) return;
	const original = history.pushState;
	const wrapped = function (this: History, ...args: Parameters<History["pushState"]>): void {
		original.apply(this, args);
		try {
			onPush();
		} catch (err) {
			console.error("[OneDollarStats] pushState handler", err);
		}
	} as History["pushState"];
	(wrapped as unknown as { __onedollarstats_wrapped: true }).__onedollarstats_wrapped = true;
	history.pushState = wrapped;
	ANY_HISTORY.__onedollarstats_wrapped = true;
}

/**
 * @internal — reset module state for tests. NEVER call from app code.
 */
export function __resetForTests(): void {
	initialized = false;
	cachedFlags = null;
	if (typeof history !== "undefined") {
		const h = history as History & { __onedollarstats_wrapped?: true };
		delete h.__onedollarstats_wrapped;
	}
}

export default OneDollarStats;
