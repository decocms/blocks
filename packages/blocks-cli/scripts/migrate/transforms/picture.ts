/**
 * Picture API migration: children → props.
 *
 * Deco-fresh's `<Picture>` wrapped `<Source>` + an `<img>` fallback as CHILDREN.
 * The new `@decocms/blocks` `Picture` is prop-based — `PictureProps` requires a
 * `sources: PictureSourceProps[]` array plus `src`/`width` (from ImageProps).
 * The children still render (`children ?? sources`) so a naive keep-children
 * approach both fails the typecheck AND double-renders (children + the bottom
 * `<Image>`). This transform converts the classic shape:
 *
 *   <Picture ATTRS>
 *     <Source src={a} width={360} media="..." />
 *     <Source src={b} width={1440} media="..." />
 *     <img src={b} alt={x} className="..." />
 *   </Picture>
 *
 * into the prop form:
 *
 *   <Picture ATTRS
 *     sources={[{ src: a, width: 360, media: "..." }, { src: b, width: 1440, media: "..." }]}
 *     src={b} width={1440} alt={x} className="..." />
 *
 * Only Pictures with `<Source>` children are touched; a Picture already using
 * `sources={...}` props is left as-is.
 */

import type { TransformResult } from "../types";

/** Parse a JSX tag's attribute string into name → raw value (`{expr}` / `"str"` / boolean). */
function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w-]*)(?:\s*=\s*(\{[^{}]*\}|"[^"]*"|'[^']*'))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    if (m[1]) attrs[m[1]] = m[2] ?? "";
  }
  return attrs;
}

/** Unwrap a raw JSX value for an object-literal field: `{image.x}` → `image.x`, `"s"` → `"s"`. */
function unwrap(v: string): string {
  return v.startsWith("{") && v.endsWith("}") ? v.slice(1, -1) : v;
}

export function transformPicture(content: string): TransformResult {
  const notes: string[] = [];
  let changed = false;

  const result = content.replace(
    /<Picture(\s[^>]*?)?>([\s\S]*?)<\/Picture>/g,
    (whole, attrStr: string | undefined, inner: string) => {
      const sourceMatches = [...inner.matchAll(/<Source\s+([^/>]*?)\/>/g)];
      if (sourceMatches.length === 0) return whole; // not the children pattern

      const sources = sourceMatches.map((mm) => parseAttrs(mm[1]));
      const imgMatch = inner.match(/<img\s+([^/>]*?)\/>/);
      const img = imgMatch ? parseAttrs(imgMatch[1]) : {};
      const last = sources[sources.length - 1]!;

      // sources={[{ src, width, height, media, sizes }, ...]}
      const srcArr = sources
        .map((s) => {
          const fields = (["src", "width", "height", "media", "sizes"] as const)
            .filter((k) => s[k] !== undefined)
            .map((k) => `${k}: ${unwrap(s[k]!)}`);
          return `{ ${fields.join(", ")} }`;
        })
        .join(", ");

      // The required-for-typecheck props (src/width/height/alt) come from the
      // <img> fallback, else the last <Source>.
      const pick = (k: string): string | undefined => img[k] ?? last[k];
      const top: string[] = [];
      for (const k of ["src", "width", "height", "alt"] as const) {
        const v = pick(k);
        if (v !== undefined && v !== "") top.push(`${k}=${v}`);
      }
      // className/loading: only lift from the <img> if the <Picture> doesn't
      // already declare it — otherwise we'd emit a duplicate attribute (React
      // keeps the last, silently dropping the Picture's own classes).
      const pictureAttrs = parseAttrs(attrStr ?? "");
      for (const k of ["className", "loading"] as const) {
        if (img[k] !== undefined && img[k] !== "" && pictureAttrs[k] === undefined) {
          top.push(`${k}=${img[k]}`);
        }
      }

      changed = true;
      notes.push(`Picture: ${sources.length} <Source> children → sources[] props`);
      return `<Picture${attrStr ?? ""} sources={[${srcArr}]} ${top.join(" ")} />`;
    },
  );

  return { content: result, changed, notes };
}
