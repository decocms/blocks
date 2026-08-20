/**
 * Analytics utilities using the data-event attribute pattern.
 * Compatible with Deco's analytics pipeline and GTM.
 */

export interface DataEventParams {
  on: "view" | "click" | "change";
  event: { name: string; params?: Record<string, unknown> };
}

export function useSendEvent({ on, event }: DataEventParams) {
  return {
    "data-event": encodeURIComponent(JSON.stringify(event)),
    "data-event-trigger": on,
  };
}

/**
 * Inline script that observes data-event attributes and dispatches events.
 * Inject once in the root layout via a <script> tag.
 *
 * Prerender-safe: while a Speculation Rules prerender is running the document
 * is hidden and its IntersectionObserver could fire phantom `view` events, so
 * all init is deferred until the page is actually activated. On a normal load
 * `document.prerendering` is false and it runs immediately (no behavior change).
 */
export const ANALYTICS_SCRIPT = `
(function() {
  function start() {
  function dispatch(event) {
    if (window.dataLayer) {
      window.dataLayer.push({ event: event.name, ...event.params });
    }
    if (window.DECO && window.DECO.events) {
      window.DECO.events.dispatch(event);
    }
  }

  function getEvent(el) {
    var raw = el.getAttribute("data-event");
    if (!raw) return null;
    try { return JSON.parse(decodeURIComponent(raw)); } catch(e) { return null; }
  }

  var viewObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        var event = getEvent(entry.target);
        if (event) dispatch(event);
        viewObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  document.addEventListener("click", function(e) {
    var el = e.target.closest("[data-event-trigger='click']");
    if (el) {
      var event = getEvent(el);
      if (event) dispatch(event);
    }
  });

  function observeAll() {
    document.querySelectorAll("[data-event-trigger='view']").forEach(function(el) {
      viewObserver.observe(el);
    });
  }

  observeAll();
  var mo = new MutationObserver(observeAll);
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(function() { mo.observe(document.body, { childList: true, subtree: true }); });
  } else {
    setTimeout(function() { mo.observe(document.body, { childList: true, subtree: true }); }, 0);
  }
  }

  if (document.prerendering) {
    document.addEventListener('prerenderingchange', start, { once: true });
  } else {
    start();
  }
})();
`;

/**
 * Dev-only guardrail for Speculation Rules. While a prerender is running (the
 * hidden pre-navigation document), NOTHING analytics-related should hit the
 * network — otherwise the pageview/event is counted for a navigation that may
 * never happen. This script patches the common egress sinks (sendBeacon, fetch,
 * injected tracker <script>/<img>) and `console.error`s the offending call so
 * the dev knows exactly which loader still needs a `document.prerendering`
 * guard before activating speculation rules on that site.
 *
 * Emit only in dev (see DecoRootLayout) — it self-disables outside prerender,
 * so it is inert on real navigations.
 */
export const SPECULATION_DEV_WARN_SCRIPT = `
(function(){
  if (!document.prerendering) return;
  var TRACKERS = /googletagmanager\\.com|google-analytics\\.com|analytics\\.google|gtag\\/js|gtm\\.js|connect\\.facebook\\.net|analytics\\.tiktok|hotjar|clarity\\.ms|doubleclick|\\/sgtm|sgtm\\.|\\/collect(\\?|$)|\\/j\\.php|vwo|tr\\?id=/i;
  function err(what, detail){
    console.error(
      '[deco][speculation] ' + what + ' ran during prerender and will double-count when the page activates. ' +
      'Guard its loader with: if (document.prerendering) { document.addEventListener("prerenderingchange", init, { once: true }); } else { init(); }',
      detail
    );
  }
  var sb = navigator.sendBeacon;
  if (sb) navigator.sendBeacon = function(url){ err('navigator.sendBeacon', url); return sb.apply(navigator, arguments); };
  var of = window.fetch;
  if (of) window.fetch = function(input){
    var u = (input && input.url) || input;
    if (TRACKERS.test(String(u))) err('fetch()', u);
    return of.apply(window, arguments);
  };
  var mo = new MutationObserver(function(muts){
    for (var i=0;i<muts.length;i++){
      var nodes = muts[i].addedNodes || [];
      for (var j=0;j<nodes.length;j++){
        var n = nodes[j];
        if (!n || !n.tagName) continue;
        if (n.tagName === 'SCRIPT' && n.src && TRACKERS.test(n.src)) err('tracker <script> load', n.src);
        else if (n.tagName === 'IMG' && n.src && TRACKERS.test(n.src)) err('tracker pixel <img>', n.src);
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('prerenderingchange', function(){
    mo.disconnect();
    if (sb) navigator.sendBeacon = sb;
    if (of) window.fetch = of;
  }, { once: true });
})();
`;

/**
 * Returns a GTM container snippet. Returns empty string if no containerId.
 *
 * Prerender-safe: container load is deferred until the page is activated so a
 * Speculation Rules prerender that never activates can't fire GTM (pageview /
 * tags) in the hidden document. No-op guard on normal loads.
 */
export function gtmScript(containerId?: string): string {
  if (!containerId) return "";
  return `(function(){function boot(){(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${containerId}');}if(document.prerendering){document.addEventListener('prerenderingchange',boot,{once:true});}else{boot();}})();`;
}
