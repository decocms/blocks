/** Element anchors for heatmaps: the ONE definition of "which element was clicked", shared by
 *  the browser runtime (`runtime/modules/heatmap.ts`) and the viewer that paints the heat on a
 *  server-rendered snapshot (insights-mcp vendors this file verbatim).
 *
 *  Both sides must produce the same hash for the same element, so this file is self-contained:
 *  no imports, no globals beyond the DOM node it is handed, nothing that differs between a
 *  visitor's browser and a sandboxed iframe. `tests/fixtures/anchor-vectors.json` pins the output;
 *  a change to anything below that moves a vector is a breaking change for every heatmap already
 *  collected, so it bumps ANCHOR_VERSION and ships in both repos at once.
 *
 *  The algorithm, exactly:
 *
 *  1. ANCHOR. From the click target, walk up at most 6 elements (target included) and take the
 *     first that matches ACTIONABLE (interactive = true). If none does, repeat the walk and take
 *     the first element carrying a `data-fs-*` attribute that is not a page wrapper, stopping at a
 *     Deco section (interactive = false). Else the target.
 *     A click on the <span> inside "Comprar" counts for the button, which is what a reader expects.
 *
 *  2. ROOT, the first that applies:
 *     a. the nearest `section[data-manifest-key]` (Deco CMS section, self included):
 *        identity `<manifest key>#<ordinal among sections with the same key, document order>`;
 *     b. the OUTERMOST element on the anchor's ancestor chain (self included, `body` excluded)
 *        carrying a `data-fs-*` attribute whose component name is not a page wrapper (WRAPPER):
 *        identity `fs:<name>#<ordinal among elements carrying that attribute>`. Outermost, not
 *        nearest: measured on FILA, New Balance and Umbro (2026-10-26), none of which render a
 *        single `data-manifest-key` section, the outermost FastStore component is the
 *        section-sized one (`hero-slideshow`, `tabbed-product-shelf`, `desktop-header`), while the
 *        nearest is a product card or a link whose ordinal shifts as lazy content loads;
 *     c. the nearest ancestor-or-self with an `id` that does not look generated (BAD_ID):
 *        identity `#<id>`;
 *     d. `body`: identity "" (the wire sends section index -1).
 *     `<name>` is the attribute name without `data-fs-`. A `data-fs-*` attribute is chosen as the
 *     alphabetically FIRST one on the element, so attribute order never matters.
 *
 *  3. PATH from root (exclusive) to anchor (inclusive), root first, segments joined by `>`:
 *     `<localName>` + (`[<first data-fs-* attribute name>]` if any) + `:` + nth-of-type (1-based).
 *     Example: `div:2>article[data-fs-product-card]:3>a:1`. Empty when the anchor is the root.
 *     Classes, text, href, src and non-root ids are excluded on purpose: classes churn on every
 *     Tailwind deploy, and text/href are PII and change daily.
 *
 *  4. HASH: `cyrb53(identity + "|" + path)`, a 53-bit integer (exact in a JS number and in JSON),
 *     sent as base36. Collision odds at ~5,000 clickable elements per page: about 1e-9.
 */
export const ANCHOR_VERSION = 1;

export const ACTIONABLE =
  "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab]," +
  '[role=menuitem],[role=option],[role=checkbox],[tabindex]:not([tabindex="-1"])';

/** FastStore component names that wrap a whole page rather than one part of it. Umbro's home is
 *  `data-fs-home` around every block; taking it as the root would put the whole page in one
 *  "section". */
export const WRAPPER = /^(home|page|layout|content|main|root|wrapper|container|region|grid)$/;

/** Ids minted by a framework or a counter: different on every render, so useless as a root. */
export const BAD_ID = /\d{4,}|^:r|^radix-|^headlessui-|[0-9a-f]{8}|react-aria|[:«»]/;

/** cyrb53 (bryc, public domain): a fast 53-bit string hash with good avalanche. */
export function cyrb53(s: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** The alphabetically first `data-fs-*` attribute name on an element, or "". */
export function fsAttr(e: Element): string {
  let m = "";
  for (const n of e.getAttributeNames()) if (n.startsWith("data-fs-") && (!m || n < m)) m = n;
  return m;
}

/** Step 1. Returns the anchor and whether it is interactive. */
export function anchorOf(t: Element): [Element, boolean] {
  let e: Element | null = t;
  for (let i = 0; e && i < 6; e = e.parentElement, i++) if (e.matches(ACTIONABLE)) return [e, true];
  // Never a page wrapper, and never across a Deco section: an <h2> clicked inside a section must
  // not anchor on the `data-fs-home` that wraps every section of the page.
  e = t;
  for (
    let i = 0;
    e && i < 6 && !e.matches("section[data-manifest-key]");
    e = e.parentElement, i++
  ) {
    const f = fsAttr(e);
    if (f && !WRAPPER.test(f.slice(8))) return [e, false];
  }
  return [t, false];
}

const ordinal = (list: NodeListOf<Element>, e: Element, same: (x: Element) => boolean) => {
  let n = 0;
  for (const x of list) {
    if (x === e) return n;
    if (same(x)) n++;
  }
  return n;
};

/** A FastStore component root by step 2b, or "" — exported so a viewer can enumerate roots. */
export function fsRootName(e: Element): string {
  const a = fsAttr(e);
  return a && !WRAPPER.test(a.slice(8)) && /^[a-z0-9-]+$/.test(a) ? a : "";
}

/** Step 2. Returns the root element (null for body) and its identity. */
export function rootOf(a: Element): [Element | null, string] {
  const d = a.ownerDocument;
  const s = a.closest("section[data-manifest-key]");
  if (s) {
    const k = s.getAttribute("data-manifest-key")!;
    return [
      s,
      k +
        "#" +
        ordinal(
          d.querySelectorAll("section[data-manifest-key]"),
          s,
          (x) => x.getAttribute("data-manifest-key") === k,
        ),
    ];
  }
  let fs: Element | null = null,
    name = "";
  for (let e: Element | null = a; e && e !== d.body; e = e.parentElement) {
    const n = fsRootName(e);
    if (n) {
      fs = e;
      name = n;
    }
  }
  if (fs)
    return [
      fs,
      "fs:" + name.slice(8) + "#" + ordinal(d.querySelectorAll("[" + name + "]"), fs, () => true),
    ];
  for (let e: Element | null = a; e && e !== d.body; e = e.parentElement) {
    if (e.id && !BAD_ID.test(e.id)) return [e, "#" + e.id];
  }
  return [null, ""];
}

/** Step 3. */
export function pathOf(root: Element | null, a: Element): string {
  const out: string[] = [];
  for (
    let e: Element | null = a, i = 0;
    e && e !== root && e !== e.ownerDocument.body && i < 64;
    e = e.parentElement, i++
  ) {
    let n = 1;
    for (let s = e.previousElementSibling; s; s = s.previousElementSibling)
      if (s.localName === e.localName) n++;
    const f = fsAttr(e);
    out.push(e.localName + (f ? "[" + f + "]" : "") + ":" + n);
  }
  return out.reverse().join(">");
}

/** Steps 2-4 for an element already chosen as anchor: what the wire carries and what a viewer
 *  matches on. `root` is the identity string ("" = body), `el` the base36 hash. */
export function anchorHash(a: Element): { root: string; el: string; rootEl: Element | null } {
  const [rootEl, root] = rootOf(a);
  return { root, el: cyrb53(root + "|" + pathOf(rootEl, a)).toString(36), rootEl };
}
