// Ported verbatim from insights-mcp web/components/heat-core.ts (branch feat/page-heatmap, 3af7d86),
// the PAGE_HEATMAP viewer, so the live-site overlay and the MCP App draw the same picture.
// Change it there first, then copy it here: two heat maths that disagree are the failure to avoid.
// One exception, owed upstream: `quantiles` (one typed sort, output identical to the old `quantile`)
// landed here first, to keep each heatmap snapshot cheap on the store's main thread.
/**
 * Pure heatmap math for the page-heatmap viewer: device buckets, matching
 * fallbacks, density field + Gaussian kernel, p99 normalisation, colour
 * ramps, scroll reach and attention bands.
 *
 * Self-contained on purpose (no module-scope references): `heatCore.toString()`
 * is injected into the snapshot iframe next to `anchorLib`, and the tests call
 * `heatCore()` directly. Data in, numbers out — no DOM.
 */
export function heatCore() {
  type Device = "desktop" | "tablet" | "mobile";
  type Box = { x: number; y: number; w: number; h: number };
  type Element = { sec: string; el: string; clicks: number; cells: [number, number][] };
  type GridCell = { fixed: boolean; xb: number; yb: number; clicks: number };

  /** Same rule as analytics_hm_device: layout follows the viewport, not the UA. */
  function deviceOf(vw: number): Device | "" {
    if (!vw) return "";
    return vw < 768 ? "mobile" : vw < 1024 ? "tablet" : "desktop";
  }

  const DESKTOP_WIDTHS = [1280, 1366, 1440, 1536, 1920];

  /** Width to render the snapshot at: the bucket's mean viewport snapped to a common screen. */
  function renderWidth(device: Device, meanVw?: number | null): number {
    if (device === "mobile") return 390;
    if (device === "tablet")
      return meanVw && meanVw >= 768 && meanVw < 1024 ? Math.round(meanVw) : 820;
    if (!meanVw || meanVw < 1024) return 1440;
    return DESKTOP_WIDTHS.reduce((a, b) => (Math.abs(b - meanVw) < Math.abs(a - meanVw) ? b : a));
  }

  /** Kernel radius in CSS px: a finger is wider than a cursor. */
  const radiusFor = (device: Device) => (device === "desktop" ? 28 : 36);

  /** Several quantiles of the positive values from ONE sort. A typed-array sort is native and
   *  numeric (no comparator call per pair): a 1M-cell field sorts in ~0.2 s instead of ~0.65 s.
   *  Float64 keeps the result exact for Float32 fields and plain numbers alike. */
  function quantiles(values: ArrayLike<number>, qs: number[]): number[] {
    const v = Float64Array.from(values)
      .filter((x) => x > 0)
      .sort();
    return qs.map((q) => {
      if (!v.length) return 0;
      const pos = (v.length - 1) * q;
      const lo = Math.floor(pos);
      return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo);
    });
  }

  function quantile(values: ArrayLike<number>, q: number): number {
    return quantiles(values, [q])[0];
  }

  /** Cells per side of the position grid inside an element, as mv_hm_elements_daily stores it
   *  (row * GRID + column). Must match the MV: migrations/2026_11_06_hm_cells_16. */
  const GRID = 16;
  /** The cell an element's clicks go to when the row has no cells: the one at its centre. */
  const CENTER_CELL = (GRID / 2 - 1) * GRID + GRID / 2 - 1;
  /** At most this many points per cell: bounds the work on the largest cells. */
  const SPREAD = 8;

  /** FNV-1a of an element's key: the seed its cells scatter from. */
  function hash(key: string): number {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return h;
  }
  /** mulberry32 over a module-local state: no closure or array per cell. */
  let rs = 0;
  function rnd(): number {
    rs = (rs + 0x6d2b79f5) | 0;
    let t = Math.imul(rs ^ (rs >>> 15), 1 | rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Places every element's clicks on the snapshot (design §6.3): on the
   * element's own box when its anchor is found, else on its section box,
   * else nowhere (the caller lists it and the coordinate grid covers it).
   *
   * A stored position is only "somewhere in this cell", so a cell's weight is spread over it.
   * Where the blur (sigma = radius / 2) is wider than the cell, one point at its centre is
   * already indistinguishable from the spread, and costs nothing extra -- most cells on mobile
   * and on small elements. Wider cells (a full-width strip: 1400 / 16 = 87 px) get a few
   * points, about one per sigma along each side, up to SPREAD, at seeded positions so a
   * redraw does not move the heat. One centred point there drew a regular grid of blobs.
   */
  function place<E extends Element>(
    elements: E[],
    findEl: (sec: string, el: string) => Box | null,
    findSec: (sec: string) => Box | null,
    radius = 28,
  ) {
    const sigma = radius / 2;
    const points: [number, number, number][] = [];
    const sections = new Map<string, { box: Box; clicks: number }>();
    const matched: E[] = [];
    const missing: E[] = [];
    let matchedClicks = 0;
    let sectionClicks = 0;
    let total = 0;
    for (const e of elements) {
      total += e.clicks;
      const b = findEl(e.sec, e.el);
      if (b && b.w > 0 && b.h > 0) {
        matchedClicks += e.clicks;
        matched.push(e);
        const cells = e.cells.length ? e.cells : ([[CENTER_CELL, e.clicks]] as [number, number][]);
        const sum = cells.reduce((s, [, n]) => s + n, 0) || 1;
        const cw = b.w / GRID,
          ch = b.h / GRID;
        const per = Math.ceil(cw / sigma) * Math.ceil(ch / sigma); // points this cell size needs
        const seed = per > 1 ? hash(`${e.sec}|${e.el}`) : 0;
        for (const [c, n] of cells) {
          // cells may be sampled-down counts: scale back to the element's click total
          const w = (n / sum) * e.clicks;
          const col = c % GRID,
            row = (c - col) / GRID;
          if (per === 1) {
            points.push([b.x + (col + 0.5) * cw, b.y + (row + 0.5) * ch, w]);
            continue;
          }
          const k = Math.max(1, Math.min(SPREAD, per, Math.round(n)));
          rs = seed ^ Math.imul(c + 1, 0x9e3779b1);
          for (let i = 0; i < k; i++)
            points.push([b.x + (col + rnd()) * cw, b.y + (row + rnd()) * ch, w / k]);
        }
        continue;
      }
      const s = e.sec ? findSec(e.sec) : null;
      if (s) {
        sectionClicks += e.clicks;
        const z = sections.get(e.sec) ?? { box: s, clicks: 0 };
        z.clicks += e.clicks;
        sections.set(e.sec, z);
      }
      missing.push(e);
    }
    return { points, sections, matched, missing, matchedClicks, sectionClicks, total };
  }

  /** Coordinate-grid fallback (xb = % of width, yb = 10 px rows; fixed rows sit in the top viewport). */
  function gridPoints(grid: GridCell[], width: number): [number, number, number][] {
    return grid.map((g) => [((g.xb + 0.5) / 100) * width, g.yb * 10 + 5, g.clicks]);
  }

  /** 1-D Gaussian weights for sigma (in cells), normalised to sum 1. */
  function kernel(sigma: number): Float32Array {
    const r = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float32Array(r * 2 + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return k;
  }

  /**
   * Density field: points splatted into `cell`-px bins, then a separable
   * Gaussian blur. A low-resolution field stretched by the browser stays
   * smooth and avoids the canvas size limits a full-page canvas would hit.
   */
  function density(
    points: [number, number, number][],
    width: number,
    height: number,
    cell: number,
    radius: number,
  ) {
    const cols = Math.max(1, Math.ceil(width / cell));
    const rows = Math.max(1, Math.ceil(height / cell));
    const a = new Float32Array(cols * rows);
    for (const [x, y, w] of points) {
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows || !(w > 0)) continue;
      a[cy * cols + cx] += w;
    }
    const k = kernel(radius / cell / 2);
    const r = (k.length - 1) / 2;
    const b = new Float32Array(a.length);
    for (let y = 0; y < rows; y++) {
      const o = y * cols;
      for (let x = 0; x < cols; x++) {
        const v = a[o + x];
        if (!v) continue;
        for (let i = -r; i <= r; i++) {
          const xx = x + i;
          if (xx >= 0 && xx < cols) b[o + xx] += v * k[i + r];
        }
      }
    }
    a.fill(0);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const v = b[y * cols + x];
        if (!v) continue;
        for (let i = -r; i <= r; i++) {
          const yy = y + i;
          if (yy >= 0 && yy < rows) a[yy * cols + x] += v * k[i + r];
        }
      }
    }
    return { field: a, cols, rows };
  }

  /** Colour stops [t, r, g, b, alpha]; cold is transparent so the page stays readable. */
  const RAMPS: Record<string, number[][]> = {
    // Clarity-like: transparent → blue → cyan → green → yellow → orange → red
    thermal: [
      [0, 0, 40, 255, 0],
      [0.08, 20, 70, 255, 0.28],
      [0.25, 0, 185, 255, 0.5],
      [0.45, 30, 220, 110, 0.62],
      [0.65, 250, 232, 40, 0.74],
      [0.82, 255, 140, 0, 0.82],
      [1, 225, 18, 30, 0.9],
    ],
    // colour-blind safe alternative
    inferno: [
      [0, 0, 0, 4, 0],
      [0.1, 40, 11, 84, 0.3],
      [0.3, 101, 21, 110, 0.5],
      [0.5, 159, 42, 99, 0.64],
      [0.7, 212, 72, 66, 0.74],
      [0.85, 245, 125, 21, 0.84],
      [1, 252, 255, 164, 0.92],
    ],
  };

  /** 256-entry RGBA lookup table for a ramp. */
  function lut(name: string): Uint8ClampedArray {
    const stops = RAMPS[name] ?? RAMPS.thermal;
    const out = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let j = 0;
      while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
      const [t0, ...a] = stops[j];
      const [t1, ...b] = stops[j + 1];
      const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
      for (let c = 0; c < 4; c++) out[i * 4 + c] = (a[c] + (b[c] - a[c]) * f) * (c === 3 ? 255 : 1);
    }
    return out;
  }

  /** CSS colour of a ramp at t (0..1), for legends and section chips. */
  function rampCss(name: string, t: number, alpha?: number): string {
    const l = lut(name);
    const i = Math.round(Math.min(1, Math.max(0, t)) * 255) * 4;
    return `rgba(${l[i]},${l[i + 1]},${l[i + 2]},${alpha ?? +(l[i + 3] / 255).toFixed(3)})`;
  }

  /**
   * Field → RGBA pixels. Normalised to `max` (the p99 cell, so one hot CTA
   * does not wash the page out); `log` compresses the long tail.
   */
  function colorize(
    field: Float32Array,
    max: number,
    table: Uint8ClampedArray,
    log = false,
  ): Uint8ClampedArray {
    const px = new Uint8ClampedArray(field.length * 4);
    if (!(max > 0)) return px;
    const lm = Math.log1p(max);
    for (let i = 0; i < field.length; i++) {
      const v = field[i];
      if (!(v > 0)) continue;
      const t = Math.min(1, log ? Math.log1p(v) / lm : v / max);
      const j = Math.round(t * 255) * 4;
      px[i * 4] = table[j];
      px[i * 4 + 1] = table[j + 1];
      px[i * 4 + 2] = table[j + 2];
      px[i * 4 + 3] = table[j + 3];
    }
    return px;
  }

  /** Share of views whose deepest point reached each depth 0..100% (from the depth histogram). */
  function reachCurve(depth: [number, number][], views?: number): Float32Array {
    const hist = new Float64Array(101);
    for (const [d, n] of depth) hist[Math.min(100, Math.max(0, Math.round(d)))] += n;
    const total = views || hist.reduce((s, n) => s + n, 0);
    const out = new Float32Array(101);
    if (!total) return out;
    let acc = 0;
    for (let d = 100; d >= 0; d--) {
      acc += hist[d];
      out[d] = Math.min(1, acc / total);
    }
    out[0] = 1; // everyone sees the top of the page
    return out;
  }

  /** Depth (0..100) where reach first drops below `share`. */
  function depthAtReach(curve: Float32Array, share: number): number {
    for (let d = 0; d <= 100; d++) if (curve[d] < share) return d;
    return 100;
  }

  /** Attention: deciseconds per 2.5% band → 40 values. */
  function attentionBands(attention: [number, number][]): Float32Array {
    const out = new Float32Array(40);
    for (const [b, ds] of attention) if (b >= 0 && b < 40) out[b] += ds;
    return out;
  }

  return {
    deviceOf,
    renderWidth,
    radiusFor,
    quantile,
    quantiles,
    GRID,
    place,
    gridPoints,
    kernel,
    density,
    lut,
    rampCss,
    colorize,
    reachCurve,
    depthAtReach,
    attentionBands,
  };
}

export type HeatCore = ReturnType<typeof heatCore>;
