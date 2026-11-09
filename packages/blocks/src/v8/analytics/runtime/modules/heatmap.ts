/** Heatmaps: where people click, how far they scroll and where their attention goes, as ONE
 *  `$heatmap` event per page view.
 *
 *  Each view (a document load, or an SPA route change to a new path) gets a random `view_id`, kept
 *  in memory only, so this works at tier 0 with no storage. Every emission is CUMULATIVE for its
 *  view -- on `visibilitychange: hidden`, on `pagehide` and on route change -- and the warehouse
 *  keeps the last one per view (`argMax(..., ts)`). That makes a lost early beacon harmless and a
 *  page that is hidden and shown five times one view, not five.
 *
 *  It rides core's flushes, so it never spends a request of its own.
 *
 *  Costs on the visitor's main thread, all bounded:
 *    - click (capture, passive): one getBoundingClientRect on the anchor, a parent walk with
 *      getComputedStyle for the fixed/sticky flag, sibling counts. Read in the CAPTURE phase,
 *      before the site's own handlers have mutated anything, so the layout read finds a clean
 *      layout instead of forcing one. No serialisation.
 *    - scroll (passive): at most one rAF per frame; `scrollHeight` at most once a second.
 *    - sections: one IntersectionObserver, callbacks off the input path.
 *  Every handler is wrapped: a failure here means "heatmap stopped", never "the page broke".
 *
 *  Never sent: text, input values, href/src, classes, coordinates of untrusted events.
 */
import { anchorOf, rootOf, pathOf, cyrb53, fsRootName } from "../../shared/anchor.ts";

window.__dqRegister?.((enqueue, cfg: Record<string, any>, onFinal, onRoute) => {
  const w = window as any,
    d = document,
    now = () => performance.now();
  // Never runs where a visitor types who they are or pays.
  const DENY = /^\/(checkout|account|login)(\/|$)|^\/(api\/io|pvt)\//i;

  let on = false,
    vid = "",
    path = "",
    t0 = 0,
    last = 0,
    input = 0,
    vis = false,
    raf = 0,
    dhAt = 0;
  let vw = 0,
    vh = 0,
    top = 0,
    dh = 0,
    sd = 0,
    am = 0;
  let roots: Map<string, number>,
    at: number[],
    ss: Map<number, number>,
    seen: Set<number>,
    clicks: any[][];
  let burst: any,
    known: WeakSet<Element>,
    idxOf: WeakMap<Element, number>,
    sent = "",
    sentAm = 0;
  // Clicks awaiting a dead-click verdict. ANY reaction clears all of them: one DOM mutation, a
  // scroll, a route change or focus moving into a text field answers every click before it.
  const pending = new Set<any>();
  const react = () => {
    pending.clear();
    mo.disconnect();
  };
  const mo = new MutationObserver(react);

  const idx = (id: string) => {
    if (!id) return -1;
    let i = roots.get(id);
    if (i === undefined) {
      if (roots.size >= 32) return -1;
      roots.set(id, (i = roots.size));
    }
    return i;
  };
  const guard =
    (f: (...a: any[]) => void) =>
    (...a: any[]) => {
      try {
        f(...a);
      } catch {
        /* heatmap stops, page lives */
      }
    };
  // Every listener goes through here: guarded, passive unless told otherwise.
  const listen = (
    t: string,
    f: (e: any) => void,
    o: AddEventListenerOptions = { passive: true },
    on: EventTarget = w,
  ) => on.addEventListener(t, guard(f), o);

  // ---- time: active ms credited to the viewport position it was spent on --------------------
  // Active = tab visible AND some input in the last 30 s, so an idle background tab does not
  // paint the hero red. Time between two ticks is credited to where the viewport WAS.
  const tick = () => {
    const n = now(),
      act = Math.min(n, input + 3e4) - last;
    if (vis && act > 0 && dh) {
      am += act;
      for (
        let i = Math.floor((top * 40) / dh),
          e = Math.min(39, Math.floor(((top + vh - 1) * 40) / dh));
        i <= e;
        i++
      )
        at[i] = (at[i] || 0) + act;
      for (const i of seen) ss.set(i, ss.get(i)! + act);
    }
    last = n;
    vis = d.visibilityState == "visible";
    vw = innerWidth;
    vh = innerHeight;
    top = scrollY;
    if (n - dhAt > 1e3) {
      const h = d.documentElement.scrollHeight;
      dhAt = n;
      if (h > dh) {
        dh = h;
        observe(d.body);
      }
    }
    sd = Math.max(sd, dh ? Math.min(100, Math.round(((top + vh) * 100) / dh)) : 100);
  };
  const poke = () => {
    const n = now();
    if (on && n - input > 3e4) tick();
    input = n;
  };

  // ---- sections: Deco sections and FastStore component roots, the same roots clicks use -----
  const io = new IntersectionObserver(
    guard((es: IntersectionObserverEntry[]) => {
      if (!on) return;
      tick();
      for (const e of es) {
        const i = idxOf.get(e.target)!;
        if (i < 0) continue;
        if (e.intersectionRatio >= 0.5 || e.intersectionRect.height >= 300) {
          seen.add(i);
          ss.set(i, ss.get(i) || 0);
        } else seen.delete(i);
      }
    }),
    { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] },
  );
  // Top-down to the first root on each branch: visits the page scaffolding, not the inside of
  // every component. Re-run when the document grows, which is when lazy sections appear.
  const observe = (p: Element, k = 0) => {
    for (const c of p?.children ?? []) {
      if (k++ > 3e3) return;
      if (c.matches("section[data-manifest-key]") || fsRootName(c)) {
        if (!known.has(c)) {
          known.add(c);
          idxOf.set(c, idx(rootOf(c)[1]));
          io.observe(c);
        }
      } else observe(c, k);
    }
  };

  // ---- view lifecycle -----------------------------------------------------------------------
  const start = () => {
    path = location.pathname;
    // Sampled ONCE per view: per-event sampling overcounts visitors (2026-08-19).
    on = cfg.h !== 0 && !DENY.test(path) && Math.random() < (cfg.hr ?? 1);
    const r = crypto.getRandomValues(new Uint32Array(2));
    vid = ((r[0] & 0x1fffff) * 4294967296 + r[1]).toString(36);
    cfg.hv = on ? vid : ""; // read by vitals, for the INP A/B by view
    t0 = last = input = now();
    dhAt = -1e4;
    dh = sd = am = 0;
    burst = 0;
    sent = "";
    notes = [];
    roots = new Map();
    at = [];
    ss = new Map();
    seen = new Set();
    clicks = [];
    // Root indices are per view: an SPA view re-observes from scratch with a fresh dictionary.
    io.disconnect();
    known = new WeakSet();
    idxOf = new WeakMap();
    if (!on) return;
    tick();
    // An SPA view starts before its new DOM exists; look again once it has rendered.
    setTimeout(
      guard(() => {
        if (on) {
          tick();
          dh = 0;
          dhAt = -1e4;
          tick();
        }
      }),
      2e3,
    );
  };

  const emit = () => {
    if (!on || cfg.h === 0) return;
    drain();
    tick();
    const a: number[] = [];
    for (let i = 0; i < at.length; i++) a.push(Math.round((at[i] || 0) / 100));
    const hm: any = {
      v: 1,
      id: vid,
      vw,
      vh,
      dh,
      sd,
      am: Math.round(am),
      at: a,
      s: [...roots.keys()].map((k) => k.slice(0, 120)),
      ss: [...ss].map(([i, ms]) => [i, Math.round(ms / 100)]),
      // Copies: the queue serialises later, and a dead flag set after this must not edit a
      // record already queued.
      c: clicks.map((c) => c.slice()),
    };
    // Never over the contract's 4 KB for this event: shed the newest clicks first.
    let j;
    while ((j = JSON.stringify(hm)).length > 3800 && hm.c.length) hm.c.pop();
    // Unchanged since the last emission -- `hidden` then `pagehide` on the way out -- is not
    // sent again: core drains on each, and a second copy would cost a second beacon. "Unchanged"
    // ignores the few ms of attention that tick between the two; a second of it is a change.
    const { am: a0, at: a1, ss: a2, ...rest } = hm;
    const sig = JSON.stringify(rest);
    if (sig == sent && hm.am - sentAm < 1e3) return;
    sent = sig;
    sentAm = hm.am;
    enqueue("$heatmap", undefined, { path, heatmap: hm });
  };

  // ---- clicks -------------------------------------------------------------------------------
  // The listener only takes notes: target, coordinates, scroll, time. The hashing and the layout
  // reads happen AFTER THE NEXT PAINT (rAF, then a task), so none of it is inside the interaction
  // INP measures -- and a layout read there would force the layout the click's own :active
  // styles just invalidated. A route change or the end of the view drains the notes first, so a
  // click is never attributed to the next view.
  const clamp = (v: number) => (v > 255 ? 255 : v > 0 ? v | 0 : 0);
  let notes: any[] = [];
  const drain = () => {
    for (const r of notes.splice(0)) record(r);
  };
  const record = ([t, cx, cy, sy, n, kb, tok]: any[]) => {
    if (!t.isConnected) return; // gone before we looked: no anchor to hash
    const [a, inter] = anchorOf(t),
      [root, id] = rootOf(a);
    const el = cyrb53(id + "|" + pathOf(root, a)).toString(36);
    const r = a.getBoundingClientRect(),
      ds = scrollY - sy;
    let f = (inter ? 16 : 0) | (kb ? 32 : 0);
    for (let p: Element | null = a; p && p != d.body; p = p.parentElement) {
      const pos = getComputedStyle(p).position;
      if (pos == "fixed" || pos == "sticky") {
        f |= 8;
        break;
      }
    }
    // Where the element was AT THE CLICK: a fixed one does not move with scroll, the rest moved
    // up by however far the page scrolled since.
    const top = f & 8 ? r.top : r.top + ds,
      left = r.left;
    // A keyboard "click" has no coordinates; it happened on the element, so use its centre.
    const x = kb ? left + r.width / 2 : cx,
      y = kb ? top + r.height / 2 : cy;
    // Rage: 3+ clicks within 1 s, each within 30 px of the first. One record, n = count.
    if (
      burst &&
      burst[0] == el &&
      n - burst[1] < 1e3 &&
      Math.hypot(x - burst[2], y - burst[3]) <= 30
    ) {
      const c = (tok.c = burst[4]);
      if (c[7] < 255) c[7]++;
      if (c[7] > 2) c[8] |= 1;
      return;
    }
    if (clicks.length >= 40) return;
    const c = (tok.c = [
      idx(id),
      el,
      clamp(((x - left) * 256) / r.width),
      clamp(((y - top) * 256) / r.height),
      Math.min(1e3, Math.max(0, Math.round((x * 1e3) / innerWidth))),
      Math.max(0, Math.round(f & 8 ? y : y + sy)),
      Math.round(n - t0),
      1,
      f | tok.f,
    ]);
    clicks.push(c);
    burst = [el, n, x, y, c];
  };
  listen(
    "click",
    (e: MouseEvent) => {
      const t = e.target as Element;
      // Untrusted clicks are not behaviour; ignored widgets and password fields are never recorded.
      // A target that is not an Element throws in `closest`, which `guard` turns into "not recorded".
      if (!on || cfg.h === 0 || !e.isTrusted || t.closest("[data-dq-ignore],input[type=password]"))
        return;
      const n = now(),
        tok: any = { f: 0 };
      if (!notes.length) requestAnimationFrame(() => setTimeout(guard(drain)));
      notes.push([t, e.clientX, e.clientY, scrollY, n, e.detail === 0, tok]);
      // Dead: nothing reacted within 1 s. Error: the errors module reported something in that second.
      // Armed NOW, since the reaction is what follows the click. Focus moving onto a clicked button
      // is not a reaction -- every button click does that.
      if (!pending.size)
        mo.observe(d, { subtree: true, childList: true, attributes: true, characterData: true });
      pending.add(tok);
      setTimeout(
        guard(() => {
          if (pending.delete(tok)) tok.f |= 2;
          if (!pending.size) mo.disconnect();
          if ((w.__dqLastErrorTs ?? -1) >= n) tok.f |= 4;
          if (tok.c) tok.c[8] |= tok.f;
        }),
        1e3,
      );
    },
    { capture: true, passive: true },
  );

  listen("scroll", () => {
    poke();
    react();
    if (on && !raf)
      raf = requestAnimationFrame(
        guard(() => {
          raf = 0;
          on && tick();
        }),
      );
  });
  for (const t of ["pointerdown", "pointermove", "keydown", "touchstart"]) listen(t, poke);
  listen("visibilitychange", () => on && tick(), {}, d);
  // `matches` throws on a non-Element target; `guard` makes that a no-op.
  listen(
    "focusin",
    (e: FocusEvent) =>
      (e.target as Element).matches("input,textarea,select,[contenteditable]") && react(),
    {},
    d,
  );
  // A page restored from the back/forward cache is a new view; the old one was emitted on pagehide.
  listen("pageshow", (e: PageTransitionEvent) => e.persisted && start());

  onFinal(emit);
  // Core calls this BEFORE the new route's $pageview. A query-string change on the same path
  // (PLP filters) is not a new view, matching core's replaceState rule.
  onRoute?.((prev: string) => {
    if (prev == location.pathname) return;
    react();
    emit();
    start();
  });
  start();
});
