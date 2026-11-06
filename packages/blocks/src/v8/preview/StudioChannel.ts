/**
 * The Studio channel's bootstrap (protocol: `src/protocol/channel.ts`,
 * exported for Studio from `@decocms/blocks/protocol`): a tiny inline script every page
 * carries, production included, so code that belongs to Studio's site editor
 * (the section wireframe, the HTML swap after a save) ships with Studio and
 * runs inside the page only when Studio frames it. It is the only way Studio
 * runs code in the page: the bridge evaluates no script Studio sends.
 *
 * The page trusts a list of Studio origins (`studioOrigins`), each one exact:
 * no wildcard, no prefix. Framed (`window.parent !== window`), it posts
 * `{ type: "deco:ready" }` with each trusted origin as the `targetOrigin`, so
 * the browser delivers it only to a parent at one of them, and to no other
 * (where the browser names the parent's origin, `location.ancestorOrigins`,
 * the page posts only to that one, when it's trusted). It imports each module
 * Studio names in `{ type: "deco:load", url }` once, when the message comes
 * from the parent at exactly one of the trusted origins and the URL is on
 * exactly the origin of that message; the module talks to that origin alone.
 * Not framed, or with no valid origin, it does nothing (and a parent of
 * another origin never gets the `deco:ready`, nor a message it sends an answer).
 *
 * An inline script, like `StudioBridge`: it listens before React hydrates, and
 * renders from a Next.js Server Component. Studio's origins travel in a
 * `data-*` attribute; the script itself is static. The binding owns the list
 * (its option, its environment override, Studio's production and staging
 * origins by default) and adds the same origins to the page's CSP
 * `script-src` (the modules) and `frame-ancestors`; `@decocms/blocks` reads no
 * environment. The inline script itself needs the site's CSP `nonce`.
 */
import { createElement, type ReactNode } from "react";

export interface StudioChannelProps {
  /**
   * Studio's origins (`https://studio.decocms.com`): the only origins whose
   * messages the page accepts and whose modules it imports, each compared
   * exactly. The binding passes them; a value that isn't an http(s) origin is
   * dropped, and with none left the channel is off.
   */
  studioOrigins: readonly string[];
  /** The CSP nonce for the inline script, when the site sends one. */
  nonce?: string;
}

const GLOBAL = "__decoStudioChannel";

/**
 * The browser side. Static. `import(h)` is the one dynamic import (a classic
 * script may `import()`); the module's default export gets the context.
 */
export const STUDIO_CHANNEL_SCRIPT = `(function(){
var s=document.currentScript,w=window,p=w.parent,t;
if(!s||p===w||w.${GLOBAL})return;
try{t=JSON.parse(s.getAttribute("data-studio-origins")||"[]")}catch(e){}
if(!Array.isArray(t)||!t.length)return;
w.${GLOBAL}=true;
var seen={},fns=[];
function send(o,m){p.postMessage(m,o)}
w.addEventListener("message",function(e){
var d=e.data,o=e.origin;
if(t.indexOf(o)<0||e.source!==p||!d||typeof d.type!=="string")return;
if(d.type!=="deco:load"){
if(d.type.indexOf("deco:")===0)return;
fns.slice().forEach(function(l){if(l.o===o)try{l.f(d)}catch(err){console.error("[deco] Studio module failed:",err)}});
return}
var h;
if(typeof d.url!=="string")return;
try{h=new URL(d.url)}catch(err){return}
if(h.origin!==o)return;
h=h.href;
if(seen[h])return;
seen[h]=1;
import(h).then(function(m){
if(typeof m.default!=="function")throw new TypeError("no default export");
return m.default({studioOrigin:o,url:h,send:function(x){send(o,x)},on:function(f){var l={o:o,f:f};fns.push(l);return function(){var i=fns.indexOf(l);if(i>=0)fns.splice(i,1)}}})
}).then(function(){send(o,{type:"deco:loaded",url:h})},function(err){
delete seen[h];
send(o,{type:"deco:load-error",url:h,message:String(err&&err.message||err)})})
});
var a=w.location.ancestorOrigins;
(a&&a.length?t.indexOf(a[0])<0?[]:[a[0]]:t).forEach(function(o){send(o,{type:"deco:ready"})});
})();`;

/** `value` as an exact http(s) origin (`https://host[:port]`; no wildcard), or `""`. */
function asOrigin(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    // A host name or an IP address: a URL parser accepts `*` in a host, which a
    // CSP source would read as a wildcard.
    if (!/^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)$/.test(url.hostname)) return "";
    return value === url.origin || value === `${url.origin}/` ? url.origin : "";
  } catch {
    return "";
  }
}

/** The valid origins of `list`, normalized, each once. */
function origins(list: readonly string[] | undefined): string[] {
  return [...new Set((Array.isArray(list) ? list : []).map(asOrigin).filter(Boolean))];
}

/**
 * The Studio channel's bootstrap. Render it once, in the root layout's
 * `<body>` (the bindings' documents do).
 */
export function StudioChannel({ studioOrigins, nonce }: StudioChannelProps): ReactNode {
  return createElement("script", {
    "data-deco-studio-channel": "",
    // Always rendered, even when off (`[]`), so the server's and the client's
    // trees match when only one side sees the binding's environment override.
    "data-studio-origins": JSON.stringify(origins(studioOrigins)),
    nonce,
    suppressHydrationWarning: true,
    dangerouslySetInnerHTML: { __html: STUDIO_CHANNEL_SCRIPT },
  });
}
