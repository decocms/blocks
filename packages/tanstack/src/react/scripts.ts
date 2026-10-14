/**
 * The inline scripts every Deco page runs, as v7's root layout ran them
 * (`@decocms/tanstack` 7.x `DecoRootLayout`, `@decocms/blocks` 7.x
 * `sdk/analytics.ts`).
 */

/** The `DECO.events` bus. Events dispatched before a subscriber exists are replayed to it. */
export function eventsBootstrap(account: string): string {
  return `
window.__RUNTIME__ = window.__RUNTIME__ || { account: ${JSON.stringify(account)} };
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

/**
 * Dispatches the events elements declare with `data-event`, on view or click.
 * It waits for a Speculation Rules prerender to activate before observing.
 */
export const DATA_EVENT_OBSERVER = `
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

export const PROGRESS_CSS = `
@keyframes progressSlide { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.nav-progress-bar { animation: progressSlide 1s ease-in-out infinite; }
`;
