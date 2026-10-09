import React, { useEffect } from "react";
import { getRequestNonce } from "../sdk/nonce";

interface LiveControlsProps {
  site?: string;
  page?: { id?: string; pathTemplate?: string };
  flags?: any[];
  /**
   * Ship the admin message bridge (`editor::inject` eval, scroll, rerender).
   * Only the editor needs it, and the editor runs the site in dev / a Studio
   * draft preview — never on published traffic, so bindings that know they are
   * serving published traffic pass `false`. Default `true` (unchanged behaviour).
   * The "." / Ctrl+Shift+E shortcut is always shipped.
   */
  editorBridge?: boolean;
}

/**
 * LiveControls bridges the deco admin (parent window) with the storefront (iframe).
 *
 * Mirrors production behavior (apps/website/components/_Controls.tsx):
 * 1. Injects __DECO_STATE for the admin to read
 * 2. Listens for postMessage events from the admin (inject scripts, scroll, rerender)
 * 3. "." opens admin in same tab, Ctrl/Cmd+"." opens in new tab, Ctrl+Shift+E also works
 */
export function LiveControls({ site, page, flags, editorBridge = true }: LiveControlsProps) {
  // Keep `window.LIVE.page` in sync with the CURRENT page across SPA
  // navigations. The bootstrap script below reads __DECO_STATE only once (on
  // initial load), so without this effect a client-side navigation would leave
  // window.LIVE.page pointing at the first page rendered — and the "." shortcut
  // would send that page's pathTemplate/id (or the "/*" fallback) instead of the
  // route the user is actually looking at.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { LIVE?: Record<string, unknown> };
    w.LIVE = w.LIVE || {};
    w.LIVE.page = page || {};
    w.LIVE.site = { name: site || "storefront" };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, page?.id, page?.pathTemplate]);

  return (
    <>
      <script
        id="__DECO_STATE"
        type="application/json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            page: page || {},
            site: { name: site || "storefront" },
            flags: flags || [],
          }),
        }}
      />
      <LiveControlsScript bridge={editorBridge} />
    </>
  );
}

/**
 * Admin message bridge: published pages never ship it (see `editorBridge`).
 * Hand-minified — inline scripts are shipped raw on every document.
 */
const BRIDGE =
  'var TR=["https://deco.cx","https://admin.deco.cx","https://play.deco.cx","https://decocms.com","https://studio.decocms.com"];' +
  'addEventListener("message",function(event){var o=event.origin;' +
  'if(!(TR.indexOf(o)!==-1||o.startsWith("https://")&&(o.endsWith(".deco.cx")||o.endsWith(".decocms.com"))||o===location.origin))return;' +
  'var data=event.data;if(!data||typeof data!=="object")return;var a=data.args;' +
  "switch(data.type){" +
  'case"editor::inject":if(a&&a.script)try{eval(a.script)}catch(e){console.error("[deco] inject error:",e)}break;' +
  'case"scrollToComponent":var el=document.querySelector(\'[data-manifest-key="\'+CSS.escape(a?.id||"")+\'"]\');' +
  'if(!el)el=document.getElementById(a?.id);if(el)el.scrollIntoView({behavior:"smooth",block:"center"});break;' +
  'case"editor::rerender":if(a?.url)try{var u=new URL(a.url,location.origin);if(u.origin===location.origin)location.href=u.href}catch(e){}}});';

/**
 * "." / Ctrl+Shift+E (Cmd/Ctrl+"." = new tab) opens the editor. Top-level only;
 * `__DECO_STATE` is read on key press, not up front.
 */
const SHORTCUT =
  'if(self===top)document.addEventListener("keydown",function(e){var t=e.target;' +
  'if(t&&(t.tagName==="INPUT"||t.tagName==="TEXTAREA"||t.tagName==="SELECT"||t.isContentEditable)||e.defaultPrevented)return;' +
  'if(!(e.ctrlKey&&e.shiftKey&&e.key==="E"||e.key==="."))return;e.preventDefault();e.stopPropagation();' +
  'var L=Object.assign({},JSON.parse(document.getElementById("__DECO_STATE")?.textContent||"{}"),window.LIVE),' +
  'p=L.page||{},h=new URL("/choose-editor","https://studio.decocms.com"),s=h.searchParams;' +
  's.set("site",L.site&&L.site.name||L.site||"storefront");s.set("domain",location.origin);' +
  'if(p.id)s.set("pageId",p.id);s.set("path",location.pathname+location.search);s.set("pathTemplate",p.pathTemplate||"/*");' +
  '(e.ctrlKey||e.metaKey)&&e.key==="."?window.open(h.toString(),"_blank"):location.href=h.toString()});';

function LiveControlsScript({ bridge }: { bridge: boolean }) {
  const script = `(function(){if(window.__DECO_LIVE_CONTROLS__)return;window.__DECO_LIVE_CONTROLS__=!0;${bridge ? BRIDGE : ""}${SHORTCUT}})();`;

  return (
    <script
      type="module"
      nonce={getRequestNonce()}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: script }}
    />
  );
}
