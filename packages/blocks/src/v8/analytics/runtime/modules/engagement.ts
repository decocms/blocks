/** Enhanced measurement: the four things every site wants counted and nobody wants to
 *  instrument by hand — how far people scroll, which links take them away, what they
 *  download, and what they search for.
 *
 *  The reason this is a MODULE and not core: it is automatic, and automatic collection is
 *  where an analytics SDK gets expensive without anyone deciding to spend. A blog does not
 *  need outbound-click tracking and should not download the code for it.
 *
 *  Every counter here is bounded on purpose. GA4 fires a scroll event at each of four
 *  thresholds, which is four events per page for one number; it sends an outbound event
 *  per click including the same link clicked twice; and none of it is capped. At 400M
 *  events a month those choices are the difference between a bill you planned and one you
 *  did not.
 */
import { LIMITS } from "../../shared/contract.ts";

window.__dqRegister?.((enqueue, _api: Record<string, unknown>, onFinal, onRoute) => {
  // ---- scroll ---------------------------------------------------------------
  // One event per page load carrying the DEEPEST point reached, not one per threshold
  // crossed. Four events to communicate a single number is the shape GA4 chose, and the
  // extra three carry no information the fourth does not.
  let deepest = 0;
  let scrollSent = false;

  const depth = () => {
    const doc = document.documentElement;
    const viewport = window.innerHeight || doc.clientHeight || 0;
    const total = Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0);
    if (total <= viewport) return 100; // nothing to scroll: the page was fully seen
    const seen = (window.scrollY || doc.scrollTop || 0) + viewport;
    return Math.max(0, Math.min(100, Math.round((seen / total) * 100)));
  };

  // Passive: a scroll listener that can block scrolling is a listener that made the site
  // worse to use, which is the one thing analytics must never do.
  addEventListener(
    "scroll",
    () => {
      const d = depth();
      if (d > deepest) deepest = d;
    },
    { passive: true },
  );

  // `prev` is set when an SPA route closes the view: the path it was measured on goes with it,
  // and the live document is already the next route's, so only what was tracked counts.
  function sendScroll(prev?: string) {
    if (scrollSent) return;
    const d = prev ? deepest : Math.max(deepest, depth());
    // Rounded to a bucket. The difference between 61% and 62% is noise, and storing it
    // raw would put a hundred distinct values into a LowCardinality dictionary for no
    // question anyone asks.
    const bucket = Math.min(100, Math.round(d / 25) * 25);
    scrollSent = true;
    enqueue("$scroll", { depth: String(bucket) }, prev ? { path: prev } : undefined);
  }

  // ---- outbound links and downloads -----------------------------------------
  const DOWNLOAD_EXT =
    /\.(pdf|zip|rar|7z|gz|tar|csv|xlsx?|docx?|pptx?|txt|dmg|exe|pkg|apk|mp3|mp4|mov|avi|wav)($|\?)/i;

  // Same link clicked twice in one page load is one fact, not two. Rage-clicking a slow
  // link is the common case and it is exactly the case that would inflate the number.
  const clicked = new Set<string>();
  const MAX_CLICKS = 20;

  addEventListener(
    "click",
    (e) => {
      const el = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!el) return;

      const href = el.href;
      if (!href || href.startsWith("javascript:")) return;

      let url: URL;
      try {
        url = new URL(href, location.href);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;

      if (clicked.size >= MAX_CLICKS || clicked.has(href)) return;

      const isDownload =
        el.hasAttribute("download") || DOWNLOAD_EXT.test(url.pathname + url.search);
      const isOutbound = url.host !== location.host;
      if (!isDownload && !isOutbound) return;

      clicked.add(href);
      // The URL is the whole point of the event, so it gets the path budget rather than the
      // value budget — a truncated destination answers nothing.
      const target = (url.host + url.pathname).slice(0, LIMITS.pathLen);
      enqueue(isDownload ? "$download" : "$outbound", { target });
    },
    { capture: true, passive: true },
  );

  // ---- site search ----------------------------------------------------------
  // A closed list of parameter names, for the same reason the campaign vocabulary is
  // closed: an open one lets any query string mint a dimension value. These are the ones
  // that actually appear on storefronts.
  const SEARCH_PARAMS = ["q", "s", "search", "query", "termo", "busca", "keyword"];

  (function searchOnce() {
    try {
      const qs = new URLSearchParams(location.search);
      for (const key of SEARCH_PARAMS) {
        const term = qs.get(key);
        if (!term) continue;
        enqueue("$search", {
          // Lowercased and trimmed so "Tenis", "tenis " and "tenis" are one term rather
          // than three rows in a top-searches report.
          term: term.trim().toLowerCase().slice(0, LIMITS.valueLen),
          param: key,
        });
        return;
      }
    } catch {
      /* a malformed query string is not worth breaking collection over */
    }
  })();

  // ---- flush ----------------------------------------------------------------
  // Scroll depth is only known when the visitor leaves. Core runs this immediately
  // before its own last flush, so the event rides out with everything else instead of
  // buying a request of its own — three modules each flushing cost three requests for
  // what is one visit's worth of data.
  onFinal(() => sendScroll());
  // One `$scroll` per VIEW. Before this, an SPA's route 2 inherited route 1's depth and the
  // whole visit sent a single event at the end, attributed to whichever path was last. A
  // query-string change on the same path is the same view, as it is for core's pageview.
  onRoute?.((prev) => {
    if (prev === location.pathname) return;
    sendScroll(prev);
    deepest = 0;
    scrollSent = false;
  });
});
