/**
 * v7's "." edit shortcut, alone: on a page that isn't framed, "." (or
 * Ctrl+Shift+E) opens the page in Studio's editor (`/choose-editor`, which
 * signs a visitor who isn't signed in in first), and Ctrl or Cmd+"." opens it
 * in a new tab. In a frame it does nothing: Studio's editor reaches a framed
 * page through the Studio channel (`StudioChannel`) only.
 *
 * Safe under a test runner that rewrites "frame-busting" code in the HTML it
 * proxies (Cypress's `modifyObstructiveCode`): the script compares no window
 * with `top` or `parent` in a form those rewrites match, so the HTML reaches
 * the browser byte for byte (a rewrite changes the length of a React Server
 * Components payload that carries the script and breaks the page).
 *
 * A key typed in a field is left alone, also in a field inside an open shadow
 * root (a third-party widget's form): its events reach the document with the
 * host as their target, so the script reads the field from the event's
 * composed path.
 *
 * The page it sends: the last `StudioPage` marker the page rendered, else the
 * `page` the binding passed, read at the keypress. An inline script with no
 * hooks, so a Server Component renders it; its settings travel in `data-*`
 * attributes (the same as v7's bridge's: `data-deco-studio-bridge`,
 * `data-site`, `data-shortcut`, `data-path-template`, `data-page-id`) and the
 * script itself is static.
 *
 * `@decocms/nextjs` and `@decocms/tanstack` each carry this file (neither
 * imports the other); tests/studio-shortcut.test.ts keeps the two the same.
 */
import { createElement, type ReactNode } from "react";

/** The page the "." shortcut opens in Studio. */
interface ShortcutPage {
  /** The page block's `path`, as `matchRoute` matched it (`/products/:slug/p`, `/*`). */
  pathTemplate?: string;
  /** The page block's id, when the site knows it. */
  id?: string;
}

export interface StudioShortcutProps {
  /** The site's name in Deco (the shortcut sends it to Studio). */
  site: string;
  /** On by default; `false` turns it off. */
  editShortcut?: boolean;
  /** The page on screen, when the component that renders the shortcut knows it. */
  page?: ShortcutPage;
  /** The CSP nonce for the inline script, when the site sends one. */
  nonce?: string;
}

/** The browser side. Static: everything it needs comes from the script element's attributes. */
export const STUDIO_SHORTCUT_SCRIPT = `(function(){
var s=document.currentScript,w=window,p=w.parent;
if(!s||p!==w||w.__decoStudioShortcut||!s.hasAttribute("data-shortcut"))return;
w.__decoStudioShortcut=true;
var site=s.getAttribute("data-site")||"";
function page(){
  var all=document.querySelectorAll("[data-deco-page]"),el=all.length?all[all.length-1]:null;
  if(!el||!el.getAttribute("data-path-template")){el=document.querySelector("script[data-deco-studio-bridge]")||s}
  return{t:el.getAttribute("data-path-template")||"",id:el.getAttribute("data-page-id")||""};
}
document.addEventListener("keydown",function(e){
  var t=e.composedPath?e.composedPath()[0]:e.target;
  if(e.defaultPrevented||(t&&(t.tagName==="INPUT"||t.tagName==="TEXTAREA"||t.tagName==="SELECT"||t.isContentEditable)))return;
  if(e.key!=="."&&!(e.ctrlKey&&e.shiftKey&&e.key==="E"))return;
  e.preventDefault();
  e.stopPropagation();
  var g=page(),h=new URL("https://studio.decocms.com/choose-editor");
  h.searchParams.set("site",site);
  h.searchParams.set("domain",location.origin);
  if(g.id)h.searchParams.set("pageId",g.id);
  h.searchParams.set("path",location.pathname+location.search);
  h.searchParams.set("pathTemplate",g.t||"/*");
  if((e.ctrlKey||e.metaKey)&&e.key==="."){w.open(h.toString(),"_blank");return}
  location.href=h.toString();
});
})();`;

/** The "." shortcut's script. Render it once, in the `<body>`. */
export function StudioShortcut({
  site,
  editShortcut = true,
  page,
  nonce,
}: StudioShortcutProps): ReactNode {
  return createElement("script", {
    "data-deco-studio-bridge": "",
    "data-site": site,
    "data-shortcut": editShortcut ? "" : undefined,
    // Read on each keypress, so a client-side navigation that re-renders the
    // script with the next page updates them.
    "data-path-template": page?.pathTemplate || undefined,
    "data-page-id": page?.id || undefined,
    nonce,
    // Browsers hide a nonce from the DOM after parsing, which React would
    // report as a hydration mismatch.
    suppressHydrationWarning: true,
    dangerouslySetInnerHTML: { __html: STUDIO_SHORTCUT_SCRIPT },
  });
}
