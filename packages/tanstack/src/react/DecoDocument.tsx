/**
 * The document every page of a Deco TanStack site renders in. Mount it as the
 * root route's component (or shell). Everything is always on:
 *
 * - `<html data-theme="light">` (DaisyUI reads its colors from it);
 * - the `DECO.events` bus and the `data-event` observer analytics go through;
 * - a progress bar during client-side navigation, and a content area that
 *   keeps its height while the next page loads;
 * - the CDN segment token and the draft this request renders, for
 *   `decoServerFnFetch` and the draft badge;
 * - `StudioBridge` (inert unless Studio frames the page; it answers Studio's
 *   origins, `STUDIO_ORIGINS`) and `DraftBadge`
 *   (only on a draft page outside Studio's frame), from `@decocms/blocks/preview`.
 */
import { DraftBadge, StudioBridge } from "@decocms/blocks/preview";
import { HeadContent, Outlet, ScriptOnce, Scripts, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { STUDIO_ORIGINS } from "../studio.ts";
import { pageValues, publishScript } from "./pageValues.ts";
import { DATA_EVENT_OBSERVER, eventsBootstrap, PROGRESS_CSS } from "./scripts.ts";

declare global {
  interface Window {
    __deco_ready?: boolean;
  }
}

export interface NavigationProgressProps {
  /** Any CSS color. Default: the site's `--color-brand-primary-500`, else the text color. */
  color?: string;
}

/** A loading bar at the top of the page during client-side navigation. */
export function NavigationProgress({
  color = "var(--color-brand-primary-500, currentColor)",
}: NavigationProgressProps) {
  const isLoading = useRouterState({ select: (s) => s.isLoading });
  if (!isLoading) return null;
  return (
    <div
      className="fixed top-0 left-0 right-0 z-[9999] h-1 overflow-hidden"
      style={{ color }}
      role="progressbar"
      aria-label="Carregando página"
    >
      <style dangerouslySetInnerHTML={{ __html: PROGRESS_CSS }} />
      {/* Track and bar are siblings so the track's 20% alpha does not inherit onto the bar. */}
      <div className="absolute inset-0" style={{ backgroundColor: "currentColor", opacity: 0.2 }} />
      <div
        className="nav-progress-bar absolute inset-y-0 left-0 w-1/3 rounded-full"
        style={{ backgroundColor: "currentColor" }}
      />
    </div>
  );
}

/** Keeps the content area's height while the next page loads, so the footer doesn't jump. */
export function StableOutlet() {
  const isLoading = useRouterState({ select: (s) => s.isLoading });
  const ref = useRef<HTMLDivElement>(null);
  const [savedHeight, setSavedHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (isLoading && ref.current) setSavedHeight(ref.current.offsetHeight);
    else if (!isLoading) setSavedHeight(undefined);
  }, [isLoading]);
  return (
    <div ref={ref} style={savedHeight ? { minHeight: savedHeight } : undefined}>
      <Outlet />
    </div>
  );
}

export interface DecoDocumentProps {
  /** The site's name in Deco (the Studio bridge's shortcut opens the page under it). */
  site: string;
  /** `<html lang>`. Default `"en"`. */
  lang?: string;
  /** `<body class>`. Default `"bg-base-200 text-base-content"`. */
  bodyClassName?: string;
  /** The commerce account, for `window.__RUNTIME__` (analytics scripts read it). */
  account?: string;
  /** Milliseconds after hydration before `deco:ready` fires. Default 500. */
  readyDelay?: number;
  /** The element around the page: `"main"` (default), or `"div"` when the page renders its own `<main>`. */
  outlet?: "main" | "div";
  /** The "." shortcut that opens the page in Studio (off by default). */
  editShortcut?: boolean;
  /** The CSP nonce for the inline scripts, when the site enforces one. */
  nonce?: string;
  /** Rendered after the page (toasts, drawers, analytics). */
  children?: ReactNode;
}

export function DecoDocument({
  site,
  lang = "en",
  bodyClassName = "bg-base-200 text-base-content",
  account = "",
  readyDelay = 500,
  outlet = "main",
  editShortcut = false,
  nonce,
  children,
}: DecoDocumentProps) {
  // Pages wait for this signal before running work that must follow hydration.
  useEffect(() => {
    const id = setTimeout(() => {
      window.__deco_ready = true;
      document.dispatchEvent(new Event("deco:ready"));
    }, readyDelay);
    return () => clearTimeout(id);
  }, [readyDelay]);

  const values = pageValues();
  const publish = publishScript(values);
  const Outer = outlet;

  return (
    <html lang={lang} data-theme="light" suppressHydrationWarning>
      <head>
        <HeadContent />
        {publish && (
          <script
            nonce={nonce}
            suppressHydrationWarning
            dangerouslySetInnerHTML={{ __html: publish }}
          />
        )}
      </head>
      <body className={bodyClassName} suppressHydrationWarning>
        <ScriptOnce>{eventsBootstrap(account)}</ScriptOnce>
        <NavigationProgress />
        <Outer>
          <StableOutlet />
        </Outer>
        {children}
        <StudioBridge
          site={site}
          trustedOrigins={STUDIO_ORIGINS}
          editShortcut={editShortcut}
          nonce={nonce}
        />
        <DraftBadge pointer={values.draft ?? null} />
        <ScriptOnce>{DATA_EVENT_OBSERVER}</ScriptOnce>
        <Scripts />
      </body>
    </html>
  );
}
