/**
 * What a Next.js site renders for Deco Studio's site editor: the Studio
 * channel (`StudioChannel` of `@decocms/blocks/preview`) and v7's "." edit
 * shortcut (`./studioShortcut.ts`). On every page, production included,
 * framed by one of Studio's origins (`studioOrigins` / `DECO_STUDIO_ORIGIN` /
 * Studio's production and staging origins, each exact), the channel loads
 * the editor's own modules from that origin; otherwise it does nothing. Not
 * framed, "." opens the page in Studio's editor.
 *
 * v8 only: v7's framed handler (`scrollToComponent`, `editor::rerender`) is
 * gone, so no script on the page compares the window with `top` or `parent`
 * in a form a test runner's "frame-busting" rewrite matches (Cypress's
 * `modifyObstructiveCode`, which would change the length of the React Server
 * Components payload that carries the script). Two inline scripts and no
 * hooks, so a Server Component renders it as is. The site's CSP allows the
 * same origins with `withStudioCsp`.
 *
 * After a save, Studio shows the new content through the App Router
 * (`StudioRefresh`, a client component, so React stays attached to the page)
 * instead of replacing the document.
 */
import { StudioChannel, type StudioPageInfo } from "@decocms/blocks/preview";
import { createElement, Fragment, type ReactNode } from "react";
import { StudioRefresh } from "./StudioRefresh.tsx";
import { studioOrigins } from "./studio.ts";
import { StudioShortcut } from "./studioShortcut.ts";

/** `site`, and optionally `editShortcut`, `page`, `nonce` and `studioOrigins`. */
export interface StudioBridgeProps {
  /** The site's name in Deco (the "." shortcut sends it to Studio). */
  site: string;
  /**
   * v7's editor shortcut: on a page that isn't framed, "." (or Ctrl+Shift+E)
   * opens it in Studio, and Ctrl or Cmd+"." opens it in a new tab. On by
   * default, as in v7; `false` turns it off.
   */
  editShortcut?: boolean;
  /**
   * The page being shown, when the layout knows it: the "." shortcut sends
   * its path template (and id). A `StudioPage` rendered by the page wins (a
   * Next.js root layout doesn't re-render per page).
   */
  page?: StudioPageInfo;
  /** The CSP nonce for the inline scripts, when the site sends one. */
  nonce?: string;
  /**
   * The Studio origins the Studio channel trusts, each an exact origin.
   * Default: `DECO_STUDIO_ORIGIN` (comma-separated), else Studio's production
   * and staging origins (`DEFAULT_STUDIO_ORIGINS`). A site with a CSP passes
   * the same list to `withStudioCsp`, which adds it to `script-src`.
   */
  studioOrigins?: readonly string[];
}

/**
 * Lets Studio's site editor select and edit sections on the page when Studio
 * frames it, and "." open the page in Studio when it doesn't. Render it once,
 * in the root layout's `<body>`.
 */
export function StudioBridge({
  site,
  editShortcut,
  page,
  nonce,
  studioOrigins: origins,
}: StudioBridgeProps): ReactNode {
  return createElement(
    Fragment,
    null,
    createElement(StudioShortcut, { site, editShortcut, page, nonce }),
    createElement(StudioChannel, { studioOrigins: studioOrigins(origins), nonce }),
    createElement(StudioRefresh),
  );
}
