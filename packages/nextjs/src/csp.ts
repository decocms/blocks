/**
 * What Studio needs in a page's Content Security Policy: its origins in
 * `script-src` (the Studio channel imports Studio's modules from them) and in
 * `frame-ancestors` (its site editor frames the page). A Next.js site writes
 * its own policy (`next.config` headers, or its proxy); it passes the
 * directives through {@link withStudioCsp}, which adds both. The origins are
 * {@link studioOrigins}: the same list `StudioBridge`'s Studio channel trusts.
 * The package's own copy (it never imports `@decocms/tanstack`). No framework
 * code: safe in every bundle.
 */
import { STUDIO_FRAME_ANCESTORS, studioOrigins } from "./studio.ts";

/** A Studio on this machine, in local development. */
export const LOOPBACK_ANCESTORS: readonly string[] = Object.freeze([
  "http://localhost:*",
  "http://127.0.0.1:*",
]);

export interface StudioCspOptions {
  /**
   * Studio's origins; default {@link studioOrigins}() (`DECO_STUDIO_ORIGIN`,
   * else production and staging). Read through {@link studioOrigins} like any
   * other value: an entry that isn't an exact http(s) origin is dropped.
   */
  studioOrigins?: readonly string[];
  /** More origins that may frame the site, besides Studio's (a marketing tool's editor). */
  frameAncestors?: readonly string[];
  /** Local development: loopback may frame the site. */
  dev?: boolean;
  /** Add `frame-ancestors` when the directives have none. Default `true`. */
  addFrameAncestors?: boolean;
}

/** The directives of a policy (`"a; b"` or `["a", "b"]`), trimmed, empty ones dropped. */
export function cspDirectives(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = typeof value === "string" ? value.split(";") : [...value];
  return list.map((d) => d.trim()).filter(Boolean);
}

const nameOf = (directive: string) => (directive.split(/\s+/, 1)[0] ?? "").toLowerCase();
const isNone = (values: readonly string[]) =>
  values.length === 1 && values[0]?.toLowerCase() === "'none'";

/** `directive` with each of `sources` it lacks appended; one that is `'none'` stays as is. */
function withSources(directive: string, sources: readonly string[]): string {
  const [name = "", ...values] = directive.split(/\s+/);
  if (isNone(values)) return directive;
  const have = new Set(values.map((v) => v.toLowerCase()));
  const extra = sources.filter((s) => !have.has(s.toLowerCase()));
  return extra.length ? [name, ...values, ...extra].join(" ") : directive;
}

/** The `frame-ancestors` sources: Studio's, the site's own, and loopback in development. */
export function studioFrameAncestors(options: StudioCspOptions = {}): string[] {
  return [
    ...new Set([
      ...STUDIO_FRAME_ANCESTORS,
      ...studioOrigins(options.studioOrigins),
      ...(options.frameAncestors ?? []),
      ...(options.dev ? LOOPBACK_ANCESTORS : []),
    ]),
  ];
}

/**
 * A policy's directives with what Studio needs added: Studio's origins in
 * `script-src` (and `script-src-elem`), so the Studio channel can import
 * Studio's modules, and a `frame-ancestors` with Studio's (when the policy has
 * none). A policy that restricts scripts only through `default-src` gets a
 * `script-src` with `default-src`'s sources plus Studio's, which allows the
 * same scripts as before and Studio's modules. A policy that doesn't restrict
 * scripts, or forbids them all (`'none'`), keeps its scripts as they are.
 * A site's own `frame-ancestors` is kept as is.
 */
export function withStudioCsp(
  directives: string | readonly string[] | undefined,
  options: StudioCspOptions = {},
): string[] {
  const origins = studioOrigins(options.studioOrigins);
  let list = cspDirectives(directives);
  if (origins.length) {
    const isScript = (d: string) => ["script-src", "script-src-elem"].includes(nameOf(d));
    if (list.some(isScript)) {
      list = list.map((d) => (isScript(d) ? withSources(d, origins) : d));
    } else {
      const fallback = list.find((d) => nameOf(d) === "default-src");
      const values = fallback?.split(/\s+/).slice(1) ?? [];
      if (fallback && !isNone(values)) {
        list.push(withSources(["script-src", ...values].join(" "), origins));
      }
    }
  }
  if (options.addFrameAncestors !== false && !list.some((d) => nameOf(d) === "frame-ancestors")) {
    list.push(
      `frame-ancestors ${studioFrameAncestors({ ...options, studioOrigins: origins }).join(" ")}`,
    );
  }
  return list;
}
