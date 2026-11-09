/** View mode: the heatmap drawn over the LIVE site, inside Studio's iframe.
 *
 *  Loaded by core ONLY when the page is framed and its URL carries `dq_view=1` (core then
 *  collects nothing at all: no pageview, no module, no beacon). A normal visitor never downloads
 *  this file. Everything here runs on the site's own origin, so it can hash the live DOM with the
 *  same `shared/anchor.ts` the runtime used on the click, measure boxes, and read element labels --
 *  which go to the parent frame and nowhere else.
 *
 *  Trust: nothing is sent and nothing is accepted until a parent from the allow-list
 *  (`https://*.decocms.com`, localhost for development) sends `init`. From then on that one
 *  origin is pinned: every outgoing message is addressed to it, every incoming one must come from
 *  it and from `window.parent`. Protocol, versioned: docs/RUNTIME_API.md -> "View mode".
 *
 *  The drawing is the insights-mcp PAGE_HEATMAP viewer's (heat-core.ts ported verbatim, heat-child
 *  adapted from a static snapshot to a live page): Gaussian density with p99 normalisation, the
 *  Térmica / Inferno ramps, scroll reach and fold lines, attention bands, section blocks.
 */
import { anchorHash } from "../../shared/anchor.ts";
import { heatCore } from "./heat-core.ts";

export const VIEW_PROTOCOL = 1;
export const ALLOWED_PARENT =
  /^(https:\/\/([a-z0-9-]+\.)*decocms\.com|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

type Row = Record<string, unknown>;
type Mode = "clicks" | "scroll" | "attention" | "sections";
export interface ViewData {
  mode: Mode;
  /** hmElements rows as the read surface returns them; `clicks` may be replaced by the parent
   *  with the weight of the selected click type (rage, dead, ...). */
  elements: {
    root: string;
    el: string;
    clicks: number | string;
    cells?: Row | [number, number][];
  }[];
  grid?: { fixed: number | boolean; xb: number; yb: number; clicks: number | string }[];
  /** hmScroll rows. */
  depth?: { depth: number; views: number | string }[];
  /** hmAttention rows. */
  attention?: { band: number; ds: number | string }[];
  /** hmSections rows. */
  sections?: { root: string; reach_pct: number; avg_s: number; clicks?: number | string }[];
  views?: number;
  /** hmSummary.avg_fold (percent of the document). */
  avgFold?: number | null;
  scale?: number;
  ramp?: "thermal" | "inferno";
  opacity?: number;
  log?: boolean;
  radius?: number;
  /** Share of grid clicks to paint for elements not on this page version (0 = none). */
  gridShare?: number;
}

const H = heatCore();
const n = (v: unknown) => Number(v) || 0;
/** The read surface sends `el` in decimal (UInt64); the wire and anchor.ts use base36. */
const dec = (el: string) => (/^\d+$/.test(el) ? el : String(parseInt(el, 36)));
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

export function startView(win: Window = window) {
  const doc = win.document,
    root = doc.documentElement;
  let origin = "";
  const post = (m: Row) => {
    if (origin) win.parent.postMessage({ dq: "hm", v: VIEW_PROTOCOL, ...m }, origin);
  };

  const css = doc.createElement("style");
  css.textContent = `
  dialog, [role=dialog], [aria-modal=true] { display: none !important; }
  *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition: none !important; }
  html { cursor: crosshair; }
  .__hm { position: absolute; left: 0; top: 0; z-index: 2147483000; pointer-events: none; overflow: hidden; }
  .__heat, .__wash { position: absolute; left: 0; top: 0; display: none; opacity: var(--op, .85); }
  .__wash { width: 100%; height: 100%; mix-blend-mode: multiply; }
  .__marks { position: absolute; inset: 0; }
  .__line { position: absolute; left: 0; right: 0; height: 0; border-top: 2px dashed rgba(17,20,24,.85); }
  .__line span { position: absolute; right: 12px; top: -13px; font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #fff; background: rgba(17,20,24,.88); padding: 6px 9px; border-radius: 999px; white-space: nowrap; }
  .__line.__fold { border-top-color: #fff; box-shadow: 0 0 0 1px rgba(17,20,24,.5); }
  .__line.__fold span { left: 12px; right: auto; background: #fff; color: #111418; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
  .__zone { position: absolute; box-sizing: border-box; border: 1.5px dashed rgba(17,20,24,.38); border-radius: 6px; }
  .__zone span { position: absolute; right: 8px; top: 8px; font: 600 11.5px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
    background: rgba(17,20,24,.78); padding: 5px 9px; border-radius: 999px; white-space: nowrap; }
  .__block { position: absolute; left: 0; right: 0; box-sizing: border-box; border: 3px solid var(--c); background: var(--f); }
  .__block div { position: absolute; left: 10px; top: 10px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline;
    font: 500 13.5px/1.25 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111418; background: rgba(255,255,255,.94);
    padding: 7px 11px; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,.18); max-width: calc(100% - 20px); }
  .__block div b { font-weight: 700; }
  .__hl { position: absolute; display: none; box-sizing: border-box; border: 2px solid #fff; border-radius: 6px;
    box-shadow: 0 0 0 2px #111418, 0 0 0 9999px rgba(17,20,24,.18); }`;
  const mk = (cls: string, tag = "div") => {
    const e = doc.createElement(tag);
    e.className = cls;
    return e;
  };
  const layer = mk("__hm"),
    canvas = mk("__heat", "canvas") as HTMLCanvasElement,
    wash = mk("__wash"),
    marks = mk("__marks"),
    hl = mk("__hl");
  for (const c of [canvas, wash, marks, hl]) layer.appendChild(c);
  const ours = (x: Node | null) => !!x && (x === layer || layer.contains(x) || x === css);

  let data: ViewData | null = null;
  let index = new Map<string, Element>(); // `${root}|${el decimal}` -> live element
  let roots = new Map<string, Element>(); // root identity -> live element
  let keyOf = new WeakMap<Element, string>(); // element -> key, for hover
  let active: string | null = null,
    hoverKey: string | null = null,
    want = new Set<string>();
  let docW = 0,
    docH = 0;
  let blocks: { key: string; y: number; h: number }[] = [];

  /** Hash every element of the live page: any element can be an anchor (a click on plain text
   *  anchors on its target). Re-run on every snapshot, so it describes the page the heat is on. */
  function reindex() {
    index = new Map();
    roots = new Map();
    keyOf = new WeakMap();
    for (const el of Array.from(doc.body.querySelectorAll("*"))) {
      if (ours(el)) continue;
      const h = anchorHash(el);
      const k = `${h.root}|${parseInt(h.el, 36)}`;
      if (!index.has(k)) index.set(k, el);
      keyOf.set(el, k);
      if (h.rootEl && !roots.has(h.root)) roots.set(h.root, h.rootEl);
    }
  }

  const box = (el: Element | null | undefined) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const x = r.left + win.scrollX;
    if (x >= docW - 1 || x + r.width <= 1) return null; // off-canvas slide / drawer
    const cs = win.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.opacity === "0") return null;
    return { x, y: r.top + win.scrollY, w: r.width, h: r.height };
  };

  /** What a person would call the element. Read here, sent to the parent only. */
  function labelOf(el: Element): string {
    const a = norm(
      el.getAttribute("aria-label") ?? el.getAttribute("alt") ?? el.getAttribute("title"),
    );
    if (a) return a.slice(0, 60);
    const t = norm((el as HTMLElement).innerText ?? el.textContent);
    if (t) return t.length > 48 ? `${t.slice(0, 46)}…` : t;
    const img = el.querySelector("img[alt], [aria-label]");
    const inner = norm(img?.getAttribute("alt") ?? img?.getAttribute("aria-label"));
    if (inner) return inner.slice(0, 60);
    const href = el.getAttribute("href");
    if (href) {
      try {
        const u = new URL(href, doc.baseURI);
        return u.pathname === "/"
          ? "Link para a home"
          : `Link para ${decodeURIComponent(u.pathname)}`;
      } catch {
        /* fall through */
      }
    }
    return el.tagName === "IMG" ? "Imagem" : `<${el.tagName.toLowerCase()}>`;
  }
  const rootName = (r: string) => {
    if (!r) return "Página";
    if (r.startsWith("#")) return r;
    const i = r.lastIndexOf("#"),
      ord = Number(r.slice(i + 1)),
      p = r.slice(0, i);
    const base = p.startsWith("fs:")
      ? p
          .slice(3)
          .replace(/-/g, " ")
          .replace(/^./, (c) => c.toUpperCase())
      : (p.split("/").pop() ?? p).replace(/\.tsx?$/, "");
    return ord > 0 ? `${base} ${ord + 1}` : base;
  };

  function line(y: number, text: string, kind: string) {
    const d = mk(`__line __${kind}`);
    d.style.top = `${y}px`;
    const s = doc.createElement("span");
    s.textContent = text;
    d.appendChild(s);
    marks.appendChild(d);
  }
  function bands(values: ArrayLike<number>, ramp: string) {
    const stops: string[] = [];
    for (let i = 0; i < values.length; i++) {
      stops.push(
        `${H.rampCss(ramp, values[i], 0.16 + 0.44 * values[i])} ${(((i + 0.5) / values.length) * 100).toFixed(2)}%`,
      );
    }
    wash.style.background = `linear-gradient(to bottom, ${stops.join(",")})`;
    wash.style.display = "block";
  }

  function draw() {
    if (!data || !origin) return;
    if (!layer.isConnected) root.appendChild(layer);
    if (!css.isConnected) (doc.head ?? root).appendChild(css);
    const d = data,
      ramp = d.ramp ?? "thermal",
      views = Math.max(1, n(d.views));
    docW = root.clientWidth;
    docH = Math.max(doc.body.scrollHeight, root.scrollHeight);
    layer.style.width = `${docW}px`;
    layer.style.height = `${docH}px`;
    layer.style.setProperty("--op", String(d.opacity ?? 0.85));
    marks.textContent = "";
    canvas.style.display = "none";
    wash.style.display = "none";

    const els = d.elements.map((e) => {
      const cells = Array.isArray(e.cells)
        ? e.cells
        : Object.entries(e.cells ?? {}).map(([c, v]) => [Number(c), n(v)] as [number, number]);
      return {
        key: `${e.root}|${dec(String(e.el))}`,
        sec: e.root,
        el: dec(String(e.el)),
        clicks: n(e.clicks),
        cells,
      };
    });
    const radius = d.radius ?? H.radiusFor(H.deviceOf(win.innerWidth) || "desktop");
    const placed = H.place(
      els,
      (sec, el) => box(index.get(`${sec}|${el}`)),
      (sec) => box(roots.get(sec)),
      radius,
    );
    const reach = H.reachCurve(
      (d.depth ?? []).map((r) => [n(r.depth), n(r.views)]),
      views,
    );
    let legend: number[] = [];

    if (d.mode === "clicks") {
      const grid = d.grid ?? [];
      const gridTotal = grid.reduce((s, g) => s + n(g.clicks), 0);
      const missing = placed.total - placed.matchedClicks - placed.sectionClicks;
      // ponytail: grid scaled by the unplaced share, not per-click exclusion (same as the viewer).
      const share = gridTotal > 0 ? Math.min(1, (missing / gridTotal) * (d.gridShare ?? 1)) : 0;
      const gp =
        share > 0
          ? H.gridPoints(
              grid.map((g) => ({ fixed: !!g.fixed, xb: g.xb, yb: g.yb, clicks: n(g.clicks) })),
              docW,
            ).map(([x, y, w]) => [x, y, w * share] as [number, number, number])
          : [];
      const cell = Math.max(3, Math.ceil(docH / 30000));
      const cur = H.density([...placed.points, ...gp], docW, docH, cell, radius);
      canvas.width = cur.cols;
      canvas.height = cur.rows;
      canvas.style.width = `${cur.cols * cell}px`;
      canvas.style.height = `${cur.rows * cell}px`;
      // One sort for the p99 normalisation and the legend, not four.
      const q = H.quantiles(cur.field, [0.5, 0.9, 0.99]);
      const px = H.colorize(cur.field, q[2], H.lut(ramp), !!d.log);
      canvas
        .getContext("2d")!
        .putImageData(
          new ImageData(px as unknown as Uint8ClampedArray<ArrayBuffer>, cur.cols, cur.rows),
          0,
          0,
        );
      canvas.style.display = "block";
      const area = (Math.PI * (radius / 2) ** 2 * 2) / (cell * cell);
      legend = q.map((v) => v * area);
      for (const [sec, z] of placed.sections) {
        const zone = mk("__zone");
        zone.style.cssText = `left:${z.box.x}px;top:${z.box.y}px;width:${z.box.w}px;height:${z.box.h}px`;
        const chip = doc.createElement("span");
        chip.textContent = `${Math.round(z.clicks * (d.scale ?? 1)).toLocaleString("pt-BR")} cliques em itens escondidos ou que mudaram`;
        zone.appendChild(chip);
        zone.dataset.key = `sec:${sec}`;
        marks.appendChild(zone);
      }
    } else if (d.mode === "scroll") {
      bands(
        Array.from({ length: 100 }, (_, i) => reach[i]),
        ramp,
      );
      if (d.avgFold)
        line((d.avgFold / 100) * docH, `Dobra média, ${Math.round(d.avgFold)}% da página`, "fold");
      for (const s of [0.75, 0.5, 0.25]) {
        const at = H.depthAtReach(reach, s);
        if (at < 100) line((at / 100) * docH, `${Math.round(s * 100)}% chegaram até aqui`, "reach");
      }
    } else if (d.mode === "attention") {
      const b = H.attentionBands((d.attention ?? []).map((r) => [n(r.band), n(r.ds)]));
      const max = Math.max(...b) || 1;
      bands(
        Array.from(b, (v) => v / max),
        ramp,
      );
      legend = [max / 10 / views];
    }

    // Blocks: every Deco section / FastStore component root on this page, with what the read
    // surface knows about it.
    const stats = new Map((d.sections ?? []).map((s) => [s.root, s]));
    const clicksBy = new Map<string, number>();
    for (const e of els) clicksBy.set(e.sec, (clicksBy.get(e.sec) ?? 0) + e.clicks);
    const out = [...roots]
      .filter(([k]) => k && !k.startsWith("#"))
      .flatMap(([key, el]) => {
        const b = box(el);
        if (!b) return [];
        const s = stats.get(key);
        return [
          {
            key,
            name: rootName(key),
            heading: norm(el.querySelector("h1, h2, h3")?.textContent).slice(0, 60),
            y: b.y,
            h: b.h,
            clicks: clicksBy.get(key) ?? 0,
            reach: s
              ? n(s.reach_pct) / 100
              : d.depth?.length
                ? reach[Math.min(100, Math.floor((b.y / docH) * 100))]
                : null,
            seconds: s ? n(s.avg_s) : null,
          },
        ];
      })
      .sort((a, b) => a.y - b.y);
    blocks = out.map(({ key, y, h }) => ({ key, y, h }));
    if (d.mode === "sections") {
      const maxC = Math.max(1, ...out.map((b) => b.clicks));
      for (const b of out) {
        const z = mk("__block"),
          t = b.clicks / maxC;
        z.dataset.key = `blk:${b.key}`;
        z.style.cssText = `top:${b.y}px;height:${b.h}px;--c:${H.rampCss(ramp, 0.15 + 0.85 * t, 1)};--f:${H.rampCss(ramp, 0.15 + 0.85 * t, 0.08 + 0.2 * t)}`;
        const chip = doc.createElement("div");
        const parts = [
          b.name,
          `${Math.round(b.clicks * (d.scale ?? 1)).toLocaleString("pt-BR")} cliques`,
        ];
        if (b.reach != null) parts.push(`${Math.round(b.reach * 100)}% viram`);
        if (b.seconds != null) parts.push(`${b.seconds.toFixed(1)} s em média`);
        for (const p of parts) {
          const s = doc.createElement(p === b.name ? "b" : "span");
          s.textContent = p;
          chip.appendChild(s);
        }
        z.appendChild(chip);
        marks.appendChild(z);
      }
    }

    paint(false);
    const items = els.map((e) => {
      const node = index.get(e.key),
        b = box(node);
      return {
        key: e.key,
        label: node ? labelOf(node) : "",
        found: b ? "el" : placed.sections.has(e.sec) ? "sec" : "none",
        y: b ? b.y : (placed.sections.get(e.sec)?.box.y ?? -1),
        h: b ? b.h : 0,
      };
    });
    post({
      t: "placed",
      items,
      blocks: out,
      height: docH,
      width: docW,
      legend,
      stats: {
        matched: placed.matchedClicks,
        inSection: placed.sectionClicks,
        total: placed.total,
        matchRate: placed.total ? placed.matchedClicks / placed.total : null,
      },
    });
  }

  const boxOfKey = (key: string) => {
    if (key.startsWith("blk:")) {
      const b = blocks.find((x) => `blk:${x.key}` === key);
      return b ? { x: 0, y: b.y, w: docW, h: b.h } : null;
    }
    return box(index.get(key));
  };
  function paint(scroll: boolean) {
    const k = hoverKey ?? active,
      b = k ? boxOfKey(k) : null;
    if (!b) {
      hl.style.display = "none";
      return;
    }
    hl.style.cssText = `display:block;left:${b.x - 3}px;top:${b.y - 3}px;width:${b.w + 6}px;height:${b.h + 6}px`;
    if (scroll) win.scrollTo({ top: Math.max(0, b.y - win.innerHeight / 3), behavior: "smooth" });
  }

  // ---- the print: the heat is drawn once and stays put -------------------------------------
  // Redrawing it against the live DOM on every scroll frame and every mutation (carousels, lazy
  // images) kept the store's main thread busy and made the page stutter. So the heat is a snapshot:
  // hash the page, place, paint, and leave it. It is taken again only when what it shows changes:
  // new data from the parent, a new width, a page that grew or shrank once it went quiet, and when
  // someone comes back to the tab. In between the page stays live underneath (it scrolls, carousels
  // turn, links hover); the heat does not follow it.
  //
  // There is deliberately NO clock. A periodic retake brings no new numbers -- the print redraws
  // the page as it is NOW, and fresher figures only ever arrive as `data` -- so all it could do was
  // spend a full re-hash and draw on the store's page at an arbitrary moment. Its one real job is
  // healing drift (a carousel moved, a section swapped), and `visibilitychange` does that job
  // better: it costs nothing while nobody is looking and fires exactly when someone looks again.
  const QUIET_MS = 1000;
  let timer = 0,
    quiet = 0,
    snapW = 0,
    snapH = 0;
  const snap = () => {
    win.clearTimeout(timer);
    timer = 0;
    if (!data) return;
    reindex();
    draw();
    snapW = docW;
    snapH = docH;
  };
  const soon = () => {
    if (!timer) timer = win.setTimeout(snap, 250);
  };
  /** Cleared with the overlay: a frame nobody is looking at holds no timer at all. This is the
   *  store's own page, and the tab can be left framed for a working day. */
  const stop = () => {
    win.clearTimeout(timer);
    timer = 0;
    win.clearTimeout(quiet);
    quiet = 0;
    snapW = snapH = 0;
  };
  /** A height change is acted on only after QUIET_MS without one, and never mid-scroll: lazy
   *  content arrives in bursts, and one snapshot after it settles is the one worth taking. */
  const settle = () => {
    win.clearTimeout(quiet);
    quiet = win.setTimeout(() => {
      quiet = 0;
      if (data && Math.max(doc.body.scrollHeight, root.scrollHeight) !== snapH) soon();
    }, QUIET_MS);
  };
  new ResizeObserver(settle).observe(doc.body);
  win.addEventListener(
    "resize",
    () => {
      if (data && root.clientWidth !== snapW) soon();
    },
    { passive: true },
  );
  win.addEventListener(
    "scroll",
    () => {
      post({ t: "scroll", top: win.scrollY, vh: win.innerHeight, dh: docH });
      if (quiet) settle();
    },
    { passive: true },
  );
  // Back to the tab after it was elsewhere: whatever the page did meanwhile, the print is redrawn
  // over it before anyone reads it.
  doc.addEventListener("visibilitychange", () => {
    if (data && doc.visibilityState === "visible") soon();
  });

  // ---- hover and select: the page is a picture, nothing navigates -----------------------------
  let mraf = 0;
  doc.addEventListener(
    "mousemove",
    (ev) => {
      if (mraf || !data) return;
      mraf = win.requestAnimationFrame(() => {
        mraf = 0;
        const y = ev.clientY + win.scrollY;
        if (data!.mode === "scroll" || data!.mode === "attention") {
          post({
            t: "hover",
            key: null,
            x: ev.clientX,
            y: ev.clientY,
            pct: docH ? Math.min(1, y / docH) : 0,
          });
          return;
        }
        let key: string | null = null;
        if (data!.mode === "sections") {
          const b = blocks.find((x) => y >= x.y && y <= x.y + x.h);
          key = b ? `blk:${b.key}` : null;
        } else {
          for (
            let el = doc.elementFromPoint(ev.clientX, ev.clientY);
            el && el !== doc.body && !key;
            el = el.parentElement
          ) {
            const k = keyOf.get(el);
            if (k && want.has(k)) key = k;
          }
        }
        if (key === hoverKey) return;
        hoverKey = key;
        paint(false);
        const el = key && !key.startsWith("blk:") ? index.get(key) : null;
        post({ t: "hover", key, label: el ? labelOf(el) : null, x: ev.clientX, y: ev.clientY });
      });
    },
    { passive: true },
  );
  doc.addEventListener("mouseleave", () => {
    hoverKey = null;
    paint(false);
    post({ t: "hover", key: null });
  });
  const block = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  doc.addEventListener(
    "click",
    (ev) => {
      block(ev);
      if (hoverKey) post({ t: "select", key: hoverKey });
    },
    true,
  );
  doc.addEventListener("submit", block, true);
  doc.addEventListener("auxclick", block, true);

  // ---- the protocol ---------------------------------------------------------------------------
  win.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== win.parent || !e.data || e.data.dq !== "hm") return;
    if (!origin) {
      // The handshake: the first message must be `init` from an allowed origin. It pins that origin.
      if (e.data.t !== "init" || !ALLOWED_PARENT.test(e.origin)) return;
      origin = e.origin;
      reindex();
      post({
        t: "ready",
        protocol: VIEW_PROTOCOL,
        url: win.location.href,
        title: doc.title,
        width: root.clientWidth,
        height: Math.max(doc.body.scrollHeight, root.scrollHeight),
        anchors: index.size,
      });
      return;
    }
    if (e.origin !== origin) return;
    const m = e.data;
    if (m.t === "init")
      post({
        t: "ready",
        protocol: VIEW_PROTOCOL,
        url: win.location.href,
        title: doc.title,
        width: root.clientWidth,
        height: docH,
        anchors: index.size,
      });
    else if (m.t === "data" && m.d) {
      data = m.d as ViewData;
      want = new Set(data.elements.map((x) => `${x.root}|${dec(String(x.el))}`));
      soon();
    } else if (m.t === "highlight") {
      active = typeof m.key === "string" ? m.key : null;
      paint(!!m.scroll);
    } else if (m.t === "scrollTo") {
      const b = typeof m.key === "string" ? boxOfKey(m.key) : null;
      win.scrollTo({
        top: b ? Math.max(0, b.y - win.innerHeight / 3) : n(m.y),
        behavior: "smooth",
      });
    } else if (m.t === "clear") {
      data = null;
      stop();
      layer.remove();
      css.remove();
    }
  });
  // Exposed for tests only: the hash this view computes for an element, same as the runtime's.
  (win as any).__dqViewKey = (el: Element) => {
    const h = anchorHash(el);
    return `${h.root}|${parseInt(h.el, 36)}`;
  };
}

startView();
