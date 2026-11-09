/** Core Web Vitals, in one event on the way out.
 *
 *  Not five events, and not one per metric as they settle. Every vital is only final when
 *  the page is: LCP can be replaced by a later element, CLS accumulates until the visitor
 *  leaves, and INP is the worst interaction of the whole visit. Sending them early means
 *  sending them wrong, and sending each separately means four extra rows carrying one
 *  number each and repeating the same page, path and visitor.
 *
 *  Deliberately not the `web-vitals` library. It is ~2 KB for an attribution model we do
 *  not use, and this is the part of the payload every visitor downloads.
 */
window.__dqRegister?.((enqueue, _api: Record<string, unknown>, onFinal) => {
  let lcp: number | null = null;
  let cls = 0;
  let inp = 0;
  let sent = false;
  // The vitals are the DOCUMENT's: LCP, FCP and TTFB belong to the hard load, never to a later
  // SPA route. They are sent on the way out, when `location` and the heatmap's view id already
  // name whatever route the visitor ended on, so both are taken here, for the page being
  // measured. The view id a microtask later, once the heatmap module (after this one in the
  // bundle) has opened its first view.
  const path = location.pathname;
  let hv: unknown;
  queueMicrotask(() => {
    hv = _api.hv;
  });

  // The first moment the page was hidden. A tab opened in the BACKGROUND — ctrl+click
  // from a listing, "open link in new tab" — keeps accruing largest-contentful-paint
  // until it is first revealed, so its LCP measures how long the visitor took to look at
  // the tab, not how long the content took to appear. Measured on a live storefront:
  // per-page LCP of 152,858 ms and 151,296 ms on product pages (the ones opened from a
  // listing, naturally) against a 936 ms p75 for the whole site — three samples are
  // enough to make the per-page panel unreadable.
  //
  // Paint metrics that land after this point are therefore dropped. TTFB, CLS and INP
  // are kept: none of them is distorted by the tab being hidden.
  let firstHidden = document.visibilityState === "hidden" ? 0 : Infinity;
  addEventListener(
    "visibilitychange",
    () => {
      firstHidden = Math.min(firstHidden, performance.now());
    },
    { once: true },
  );
  const whileVisible = (v: number | null) => (v === null || v > firstHidden ? null : v);

  const observe = (type: string, cb: (entries: any[]) => void, opts: any = {}) => {
    try {
      const po = new PerformanceObserver((list) => cb(list.getEntries()));
      po.observe({ type, buffered: true, ...opts });
      return po;
    } catch {
      return null;
    } // an unsupported entry type must not break collection
  };

  // The LAST largest-contentful-paint wins: the browser reports a new one whenever a
  // bigger element arrives, and only the final value is the metric.
  observe("largest-contentful-paint", (es) => {
    const last = es[es.length - 1];
    if (last) lcp = last.startTime;
  });

  // CLS excludes shifts within 500ms of an interaction — a layout change the visitor
  // asked for is not "unexpected", and counting it punishes responsive UI.
  observe("layout-shift", (es) => {
    for (const e of es) if (!e.hadRecentInput) cls += e.value;
  });

  // A true INP is the 98th percentile of interaction latencies. Keeping every interaction
  // to compute that costs memory on a page that may run for an hour, so this is the worst
  // one — which is INP exactly whenever a visit has fewer than fifty interactions, and an
  // upper bound otherwise. The direction of the error is knowable, which is what matters.
  observe(
    "event",
    (es) => {
      for (const e of es) if (e.duration > inp) inp = e.duration;
    },
    { durationThreshold: 40 },
  );

  const paintOnce = (name: string): number | null => {
    try {
      const e = performance.getEntriesByName(name)[0] as PerformanceEntry | undefined;
      return e ? e.startTime : null;
    } catch {
      return null;
    }
  };

  const ttfb = (): number | null => {
    try {
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      return nav ? nav.responseStart : null;
    } catch {
      return null;
    }
  };

  function send() {
    if (sent) return;
    sent = true;
    const fcp = paintOnce("first-contentful-paint");
    const t = ttfb();
    // Nothing observed at all means an unsupported browser, not a fast page. Sending a
    // row of nulls would dilute every average with visits that were never measured.
    if (lcp === null && fcp === null && t === null && cls === 0 && inp === 0) return;
    enqueue("$vitals", undefined, {
      path,
      vital_lcp: whileVisible(lcp),
      vital_inp: inp || null,
      vital_cls: Math.round(cls * 10000) / 10000,
      vital_ttfb: t,
      vital_fcp: whileVisible(fcp),
      // The heatmap module's view id when it sampled this view: the pilot's INP guardrail compares
      // views with and without heatmap capture on the same site and days.
      heatmap: hv ? { id: hv } : undefined,
    });
  }

  // Every vital is only final when the page is, so this rides out on core's last flush.
  onFinal(send);
});
