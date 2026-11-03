/**
 * `@decocms/blocks/analytics`: cookie-free page views in the One Dollar Stats
 * tracker's wire format. See /next/analytics and
 * /next/telemetry-internals#analytics-events.
 *
 * `AnalyticsScript` renders one small inline script with the resolved
 * `analytics` block's settings. In the browser it sends a page view on load
 * (once the page is visible, so prerendered pages don't count) and on every
 * navigation that changes the path, and exposes the sender `track` uses.
 * Beside it, it renders the Deco Analytics tag (decocms/analytics), which
 * collects on its own: from the collector's origin with `decoAnalyticsKey`, or
 * from the site's own host with `decoAnalyticsFirstParty`.
 *
 * Wire format (pinned against onedollarstats' stonks.js tracker):
 * `{ u, e: [{ t, h, r, p }], debug }`, where `u` is the page URL without its
 * query string, hash or trailing slash, `t` the event type (`PageView` or a
 * custom name), `h` hash routing (always false), `r` a referrer from another
 * host and `p` the event's properties. Sent as `GET <collector>?data=<base64
 * of the UTF-8 JSON>` when that's at most 1500 characters, otherwise with
 * `navigator.sendBeacon` or a `POST`.
 */
import { createElement, Fragment, type ReactNode } from "react";
import {
  DECO_ANALYTICS_ORIGIN,
  DECO_ANALYTICS_SCRIPT,
  HOSTED_ANALYTICS_COLLECTOR,
} from "./builtins/data.ts";
import type { Analytics } from "./types.ts";

const GLOBAL = "__decoAnalytics";

/** The browser tracker. Static: the collector reaches it through `data-url`, never string-built. */
const TRACKER = `(function(){var s=document.currentScript,c=s&&s.getAttribute("data-url");if(!c||window.${GLOBAL})return;var last;function post(b){if(navigator.sendBeacon&&navigator.sendBeacon(c,b))return;fetch(c,{method:"POST",body:b,headers:{"Content-Type":"application/json"},keepalive:true}).catch(function(){})}function send(t,p){var u=new URL(location.href);u.search="";u.hash="";var r;try{if(document.referrer){var f=new URL(document.referrer);if(f.hostname!==u.hostname){f.search="";f.hash="";r=f.href}}}catch(e){}var b=JSON.stringify({u:u.href.replace(/\\/$/,""),e:[{t:t,h:false,r:r,p:p}],debug:false});var d=btoa(String.fromCharCode.apply(null,Array.from(new TextEncoder().encode(b))));if(d.length<=1500){new Image(1,1).src=c+"?data="+d}else post(b)}function view(){if(location.pathname===last)return;last=location.pathname;send("PageView")}window.${GLOBAL}={track:function(n,p){send(n,p)}};var h=history.pushState;history.pushState=function(){h.apply(this,arguments);requestAnimationFrame(view)};addEventListener("popstate",function(){requestAnimationFrame(view)});if(document.visibilityState==="visible")view();else document.addEventListener("visibilitychange",function v(){if(document.visibilityState==="visible"){document.removeEventListener("visibilitychange",v);view()}})})();`;

/**
 * The Deco Analytics tag's URL. Null without a key: on the collector's origin
 * nothing else identifies the site, so its events would be dropped.
 */
function decoAnalyticsSrc(props: Analytics): string | null {
  if (props.decoAnalyticsFirstParty === true) return DECO_ANALYTICS_SCRIPT;
  if (!props.decoAnalyticsKey) return null;
  return `${DECO_ANALYTICS_ORIGIN}${DECO_ANALYTICS_SCRIPT}?k=${encodeURIComponent(props.decoAnalyticsKey)}`;
}

/**
 * The tracking script, and the Deco Analytics tag when the site has one. Render
 * it in your root layout with the resolved `analytics` block's settings; renders
 * nothing when `enabled` is false.
 */
export function AnalyticsScript(props: Analytics = {}): ReactNode | null {
  if (props.enabled === false) return null;
  const tracker = createElement("script", {
    "data-url": props.collector ?? HOSTED_ANALYTICS_COLLECTOR,
    dangerouslySetInnerHTML: { __html: TRACKER },
  });
  const src = decoAnalyticsSrc(props);
  if (!src) return tracker;
  return createElement(Fragment, null, tracker, createElement("script", { async: true, src }));
}

/**
 * Sends your own event from the browser, through the script `AnalyticsScript`
 * renders. Does nothing without it (and on the server).
 */
export function track(name: string, props?: Record<string, string | number | boolean>): void {
  const tracker =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as Record<string, { track?: typeof track } | undefined>)[GLOBAL];
  tracker?.track?.(name, props);
}
