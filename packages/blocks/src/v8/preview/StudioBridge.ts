/**
 * The Studio bridge: what lets Deco Studio's site editor drive a page it
 * shows in an iframe (v7's `LiveControls`).
 *
 * When the frame loads, Studio posts `{ type: "editor::inject", args: {
 * script } }` to it; the bridge runs that script, which draws the section
 * overlay and handles Studio's `cms-editor::*` messages itself. The bridge also
 * answers v7's `scrollToComponent` and `editor::rerender` (same-origin
 * navigation only).
 *
 * It does nothing unless the page is framed, and in a frame it answers only
 * messages from the parent window whose origin is one of `trustedOrigins`.
 * The binding passes Studio's origins in (`@decocms/blocks` holds no list of
 * them); with none, the bridge answers nothing. It doesn't trust the page's own
 * origin: under a test runner that proxies the site, the runner's own messages
 * would navigate the page.
 *
 * An inline script, not an effect: Studio posts on the frame's `load` event,
 * which can come before React hydrates, so the listener must exist as soon as
 * the HTML is parsed. No hooks, so it renders from a Next.js Server Component
 * as well as from a client tree. Its settings travel in `data-*` attributes;
 * the script itself is static.
 */
import { createElement, type ReactNode } from "react";

export interface StudioBridgeProps {
  /** The site's name in Deco (the "." shortcut sends it to Studio). */
  site: string;
  /**
   * The origins Studio's site editor frames the page from, in the CSP source
   * form (`https://host`, or `https://*.host` for any name under it, same
   * scheme and port). Required: the binding owns Studio's origins and passes
   * them here. An empty list makes the bridge answer nothing.
   */
  trustedOrigins: readonly string[];
  /**
   * v7's editor shortcut: on a page that isn't framed, "." (or Ctrl+Shift+E)
   * opens it in Studio, and Ctrl or Cmd+"." opens it in a new tab. Off by
   * default.
   */
  editShortcut?: boolean;
  /** The CSP nonce for the inline script, when the site sends one. */
  nonce?: string;
}

/** Where the "." shortcut sends an editor; Studio picks the project the site belongs to. */
const CHOOSE_EDITOR_URL = "https://studio.decocms.com/choose-editor";

const GLOBAL = "__decoStudioBridge";

/** The browser side. Static: everything it needs comes from the script element's attributes. */
export const STUDIO_BRIDGE_SCRIPT = `(function(){
var s=document.currentScript;
if(!s||window.${GLOBAL})return;
window.${GLOBAL}=true;
var origins=[];
try{origins=JSON.parse(s.getAttribute("data-origins")||"[]")}catch(e){}
var site=s.getAttribute("data-site")||"";
function trusted(o){
  if(typeof o!=="string"||!o)return false;
  var u;
  try{u=new URL(o)}catch(e){return false}
  if(u.origin!==o)return false;
  for(var i=0;i<origins.length;i++){
    var p=origins[i];
    if(p===o)return true;
    var m=/^([a-z][a-z0-9+.-]*:)\\/\\/\\*\\.([^\\/:]+)(?::([0-9]+))?$/.exec(p);
    if(m&&u.protocol===m[1]&&u.port===(m[3]||"")&&u.hostname.slice(-m[2].length-1)==="."+m[2])return true;
  }
  return false;
}
if(window.self!==window.top){
  window.addEventListener("message",function(e){
    if(e.source!==window.parent||!trusted(e.origin))return;
    var d=e.data;
    if(!d||typeof d!=="object")return;
    var a=d.args||{};
    if(d.type==="editor::inject"){
      if(typeof a.script==="string"){try{(0,eval)(a.script)}catch(err){console.error("[deco] Studio script failed:",err)}}
    }else if(d.type==="scrollToComponent"){
      var id=typeof a.id==="string"?a.id:"";
      if(!id)return;
      var el=null,all=document.querySelectorAll("[data-manifest-key]");
      for(var i=0;i<all.length&&!el;i++)if(all[i].getAttribute("data-manifest-key")===id)el=all[i];
      el=el||document.getElementById(id);
      if(el)el.scrollIntoView({behavior:"smooth",block:"center"});
    }else if(d.type==="editor::rerender"){
      if(typeof a.url!=="string")return;
      try{var t=new URL(a.url,location.origin);if(t.origin===location.origin)location.href=t.href}catch(err){}
    }
  });
}else if(s.hasAttribute("data-shortcut")){
  document.addEventListener("keydown",function(e){
    var t=e.target;
    if(e.defaultPrevented||(t&&(t.tagName==="INPUT"||t.tagName==="TEXTAREA"||t.tagName==="SELECT"||t.isContentEditable)))return;
    if(e.key!=="."&&!(e.ctrlKey&&e.shiftKey&&e.key==="E"))return;
    e.preventDefault();
    e.stopPropagation();
    var h=new URL("${CHOOSE_EDITOR_URL}");
    h.searchParams.set("site",site);
    h.searchParams.set("domain",location.origin);
    h.searchParams.set("path",location.pathname+location.search);
    h.searchParams.set("pathTemplate","/*");
    if((e.ctrlKey||e.metaKey)&&e.key==="."){window.open(h.toString(),"_blank");return}
    location.href=h.toString();
  });
}
})();`;

/**
 * Lets Studio's site editor select and edit sections on the page. Render it
 * once, in the root layout's `<body>`.
 */
export function StudioBridge({
  site,
  trustedOrigins,
  editShortcut = false,
  nonce,
}: StudioBridgeProps): ReactNode {
  return createElement("script", {
    "data-deco-studio-bridge": "",
    "data-site": site,
    "data-origins": JSON.stringify(trustedOrigins),
    "data-shortcut": editShortcut ? "" : undefined,
    nonce,
    // Browsers hide a nonce from the DOM after parsing, which React would
    // report as a hydration mismatch.
    suppressHydrationWarning: true,
    dangerouslySetInnerHTML: { __html: STUDIO_BRIDGE_SCRIPT },
  });
}
