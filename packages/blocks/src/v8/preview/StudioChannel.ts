/**
 * The Studio channel's bootstrap (protocol: `src/protocol/channel.ts`,
 * exported for Studio from `@decocms/blocks/protocol`): a tiny inline script every page
 * carries, production included, so code that belongs to Studio's site editor
 * (the section wireframe, the HTML swap after a save) ships with Studio and
 * runs inside the page only when Studio frames it.
 *
 * Framed (`window.parent !== window`), it posts `{ type: "deco:ready" }` to the
 * parent, addressed to Studio's origin, and imports each module Studio names in
 * `{ type: "deco:load", url }` once, when the message comes from the parent at
 * exactly Studio's origin and the URL is on exactly that origin. Not framed, or
 * with no valid origin, it does nothing (and a parent of another origin never
 * gets the `deco:ready`, nor a message it sends an answer).
 *
 * An inline script, like `StudioBridge`: it listens before React hydrates, and
 * renders from a Next.js Server Component. Studio's origin travels in a
 * `data-*` attribute; the script itself is static. The binding owns the origin
 * (its option, its environment override, Studio's production origin by
 * default); `@decocms/blocks` reads no environment.
 *
 * A site with a Content Security Policy allows Studio's origin in
 * `script-src` (the modules) and this script by its `nonce`.
 */
import { createElement, type ReactNode } from "react";

export interface StudioChannelProps {
  /**
   * Studio's origin (`https://studio.decocms.com`): the only origin whose
   * messages the page accepts and whose modules it imports. The binding passes
   * it; a value that isn't an http(s) origin turns the channel off.
   */
  studioOrigin: string;
  /** The CSP nonce for the inline script, when the site sends one. */
  nonce?: string;
}

const GLOBAL = "__decoStudioChannel";

/**
 * The browser side. Static. `import(h)` is the one dynamic import (a classic
 * script may `import()`); the module's default export gets the context.
 */
export const STUDIO_CHANNEL_SCRIPT = `(function(){
var s=document.currentScript,w=window,p=w.parent;
if(!s||p===w||w.${GLOBAL})return;
var o=s.getAttribute("data-studio-origin")||"";
if(!o)return;
w.${GLOBAL}=true;
var seen={},fns=[];
function send(m){p.postMessage(m,o)}
w.addEventListener("message",function(e){
var d=e.data;
if(e.origin!==o||e.source!==p||!d||typeof d.type!=="string")return;
if(d.type!=="deco:load"){
if(d.type.indexOf("deco:")===0)return;
fns.slice().forEach(function(f){try{f(d)}catch(err){console.error("[deco] Studio module failed:",err)}});
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
return m.default({studioOrigin:o,url:h,send:send,on:function(f){fns.push(f);return function(){var i=fns.indexOf(f);if(i>=0)fns.splice(i,1)}}})
}).then(function(){send({type:"deco:loaded",url:h})},function(err){
delete seen[h];
send({type:"deco:load-error",url:h,message:String(err&&err.message||err)})})
});
send({type:"deco:ready"});
})();`;

/** `value` as an http(s) origin (`https://host[:port]`), or `""`. */
function asOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return value === url.origin || value === `${url.origin}/` ? url.origin : "";
  } catch {
    return "";
  }
}

/**
 * The Studio channel's bootstrap. Render it once, in the root layout's
 * `<body>` (the bindings' documents do).
 */
export function StudioChannel({ studioOrigin, nonce }: StudioChannelProps): ReactNode {
  return createElement("script", {
    "data-deco-studio-channel": "",
    // Always rendered, even when off (empty), so the server's and the client's
    // trees match when only one side sees the binding's environment override.
    "data-studio-origin": asOrigin(studioOrigin),
    nonce,
    suppressHydrationWarning: true,
    dangerouslySetInnerHTML: { __html: STUDIO_CHANNEL_SCRIPT },
  });
}
