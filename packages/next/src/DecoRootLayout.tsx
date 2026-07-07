import type { ReactNode } from "react";
import { LiveControls } from "@decocms/live/hooks";
import { ANALYTICS_SCRIPT } from "@decocms/live/sdk/analytics";

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
  children?: ReactNode;
}

/**
 * Root layout for app/layout.tsx — the Next.js analogue of
 * `@decocms/tanstack`'s `DecoRootLayout`.
 *
 * The bootstrap/analytics <script> tags run once per navigation session
 * because Next.js App Router doesn't remount a shared layout.tsx across
 * same-layout navigations — the same property TanStack's <ScriptOnce>
 * provides explicitly, here implicit in the framework's own layout model.
 * That's why a plain inline <script> (rather than a ScriptOnce-like helper)
 * is sufficient here.
 *
 * No <head>/<HeadContent> equivalent: Next.js App Router injects
 * `generateMetadata`'s output automatically, and a root layout.tsx doesn't
 * render its own <head> element by convention.
 *
 * No NavigationProgress/StableOutlet port in v1 — those are
 * TanStack-Router-specific SPA-navigation UX polish (a loading bar during
 * client-side nav, height-preserved outlet), not part of the core
 * CMS-rendering feature set this plan scopes.
 */
export function DecoRootLayout({
  lang = "en",
  dataTheme = "light",
  siteName,
  account,
  bodyClassName = "bg-base-200 text-base-content",
  children,
}: DecoRootLayoutProps) {
  return (
    <html lang={lang} data-theme={dataTheme} suppressHydrationWarning>
      <body className={bodyClassName} suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: buildDecoEventsBootstrap(account) }} />
        {children}
        <LiveControls site={siteName} />
        <script dangerouslySetInnerHTML={{ __html: ANALYTICS_SCRIPT }} />
      </body>
    </html>
  );
}
