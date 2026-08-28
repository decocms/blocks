import { useEffect, type ReactNode } from "react";
import { HeadContent, Scripts, ScriptOnce, useRouterState } from "@tanstack/react-router";
import { LiveControls, Stats } from "@decocms/blocks/hooks";
import {
	ANALYTICS_SCRIPT,
	SPECULATION_DEV_WARN_SCRIPT,
} from "@decocms/blocks/sdk/analytics";
import { isDevMode } from "@decocms/blocks/sdk/env";
import {
	buildSpeculationRules,
	getSpeculationRules,
	type SpeculationRulesConfig,
} from "../sdk/speculationRules";
import { DraftPreviewIndicator } from "./DraftPreviewIndicator";
import { NavigationProgress } from "./NavigationProgress";
import { StableOutlet } from "./StableOutlet";

declare global {
	interface Window {
		__deco_ready?: boolean;
	}
}

function buildDecoEventsBootstrap(account?: string): string {
	const accountJson = JSON.stringify(account ?? "");
	return `
window.__RUNTIME__ = window.__RUNTIME__ || { account: ${accountJson} };
window.DECO = window.DECO || {};
window.DECO.events = window.DECO.events || {
  _q: [],
  _subs: [],
  dispatch: function(e) {
    this._q.push(e);
    for (var i = 0; i < this._subs.length; i++) {
      try { this._subs[i](e); } catch(err) { console.error('[DECO.events]', err); }
    }
  },
  subscribe: function(fn) {
    this._subs.push(fn);
    for (var i = 0; i < this._q.length; i++) {
      try { fn(this._q[i]); } catch(err) {}
    }
  }
};
window.dataLayer = window.dataLayer || [];
`;
}

export interface DecoRootLayoutProps {
	/** Language attribute for the <html> tag. Default: "en" */
	lang?: string;
	/** DaisyUI data-theme attribute. Default: "light" */
	dataTheme?: string;
	/** Site name for LiveControls (admin iframe communication). Required. */
	siteName: string;
	/** Commerce platform account name for analytics bootstrap (e.g. VTEX account). */
	account?: string;
	/** CSS class for <body>. Default: "bg-base-200 text-base-content" */
	bodyClassName?: string;
	/** Delay in ms before firing deco:ready event. Default: 500 */
	decoReadyDelay?: number;
	/**
	 * Opt-in Speculation Rules API config override. Normally activated site-wide
	 * via `createDecoWorkerEntry({ speculationRules })` (like `asJson` /
	 * `renderJson`) and read from that shared config; pass this prop only to
	 * override it for a specific root. When set, emits a
	 * `<script type="speculationrules">` in <head> so the browser prerenders/
	 * prefetches the next document on intent. Ships DISABLED — only activate on
	 * sites whose analytics/pixel loaders are prerender-guarded.
	 * @see buildSpeculationRules
	 */
	speculationRules?: SpeculationRulesConfig;
	/**
	 * Extra content rendered inside <body> after the main outlet
	 * (e.g. Toast, custom analytics components).
	 */
	children?: ReactNode;
}

/**
 * Standard Deco root layout component for use in __root.tsx.
 *
 * Provides:
 * - NavigationProgress (loading bar during SPA nav)
 * - StableOutlet (height-preserved content area)
 * - DECO.events bootstrap (via ScriptOnce — runs before hydration, once)
 * - LiveControls for admin
 * - Analytics script (via ScriptOnce)
 * - deco:ready hydration signal
 *
 * QueryClientProvider should be configured via createDecoRouter's `Wrap` option
 * (per TanStack docs — non-DOM providers go on the router, not in components).
 *
 * Sites that need full control should compose from the individual exported
 * pieces (NavigationProgress, StableOutlet, etc.) instead.
 */
export function DecoRootLayout({
	lang = "en",
	dataTheme = "light",
	siteName,
	account,
	bodyClassName = "bg-base-200 text-base-content",
	decoReadyDelay = 500,
	speculationRules,
	children,
}: DecoRootLayoutProps) {
	useEffect(() => {
		const id = setTimeout(() => {
			window.__deco_ready = true;
			document.dispatchEvent(new Event("deco:ready"));
		}, decoReadyDelay);
		return () => clearTimeout(id);
	}, [decoReadyDelay]);

	// Pull the resolved CMS page's route pattern (`path` = pathTemplate) and block
	// id (`blockKey`) out of the current route's loader data so LiveControls sends
	// the admin the page the user is actually on — not the hardcoded "/*" fallback.
	// The CMS page loader (cmsRoute) spreads both fields onto its loader data;
	// we scan matches deepest-first to find the one that carries them.
	const page = useRouterState({
		select: (state) => {
			for (let i = state.matches.length - 1; i >= 0; i--) {
				const data = state.matches[i]?.loaderData as
					| { path?: unknown; blockKey?: unknown }
					| undefined;
				if (data && typeof data.path === "string") {
					return {
						id: typeof data.blockKey === "string" ? data.blockKey : undefined,
						pathTemplate: data.path,
					};
				}
			}
			return undefined;
		},
	});

	// Worker-entry option wins; prop is a per-root override. Undefined → disabled.
	const speculation = speculationRules ?? getSpeculationRules();

	return (
		<html lang={lang} data-theme={dataTheme} suppressHydrationWarning>
			<head>
				<HeadContent />
				{speculation && (
					<script
						type="speculationrules"
						// JSON is inert; dangerouslySetInnerHTML avoids React escaping
						// `>` in selectors (e.g. "nav > a"). Same pattern as JSON-LD.
						dangerouslySetInnerHTML={{
							__html: buildSpeculationRules(speculation),
						}}
					/>
				)}
				{/* Dev-only: console.error when analytics fire during a prerender
				    so the dev fixes unguarded loaders before shipping. */}
				{speculation && isDevMode() && (
					<script
						dangerouslySetInnerHTML={{ __html: SPECULATION_DEV_WARN_SCRIPT }}
					/>
				)}
			</head>
			<body className={bodyClassName} suppressHydrationWarning>
				<ScriptOnce children={buildDecoEventsBootstrap(account)} />
				{/*
				 * AFTER the bootstrap above, and in the body rather than the head. The collector's
				 * deco module subscribes with `window?.DECO?.events?.subscribe?.(…)` — once,
				 * optional-chained, with no retry. In the head it is an `async` script the parser
				 * can reach and run before the inline bootstrap below it has defined
				 * `DECO.events`, and the subscription would simply not happen: pageviews would
				 * still flow while every commerce event went nowhere, with no error. Here the
				 * parser has already executed the bootstrap.
				 *
				 * Rendering unconditionally is safe — the component returns null unless
				 * DECO_ANALYTICS_ENABLED is exactly "true", which is what makes this an env-var
				 * change for a site instead of a code change.
				 */}
				<Stats />
				<NavigationProgress />
				<main>
					<StableOutlet />
				</main>
				{children}
				<DraftPreviewIndicator />
				<LiveControls site={siteName} page={page} />
				<ScriptOnce children={ANALYTICS_SCRIPT} />
				<Scripts />
			</body>
		</html>
	);
}
