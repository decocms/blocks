/**
 * renderJson — structured JSON projection of a resolved page for the mobile app.
 *
 * A section controls how it renders to JSON through a recognized named export
 * `renderJson` (same convention family as `loader`/`action`/`LoadingFallback`):
 *
 * - `export const renderJson = false` — drop the section from the JSON entirely
 *   (web-only: theme/analytics/SEO/scripts). It also short-circuits the loader
 *   in {@link runSectionLoaders} (no data fetch for a dropped section).
 * - `export const renderJson = (props) => projected` — a pure projection applied
 *   to the resolved props before serialization (typically {@link deepOmit} of
 *   internal/SEO/store-config fields).
 * - no export — the section serializes with its full resolved props.
 *
 * The whole-page envelope (`?renderJson`) is `{ name, path, sections }`, where
 * each section is `{ component, props }`. This is the lean shape — no admin
 * `resolveChain`/metadata (unlike the legacy `?asJson`).
 *
 * Ported from the deco-runtime fork's `serialize-section.ts`, adapted for the
 * TanStack pipeline: sections are resolved EAGERLY before serialization, so this
 * serializer has no lazy-placeholder (`{ component, lazyUrl }`) branch — the
 * mobile app receives the whole page in one request.
 *
 * ponytail: no nested section-in-section recursion (composite/layout sections).
 * deepOmit handles trimming within a single section's data; add a recursive walk
 * here if a composite section must project its child sections.
 */

// deno-lint-ignore-style any: a projection accepts the section's own resolved props.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RenderJson = ((props: any) => Record<string, unknown>) | false;

export interface RenderJsonModule {
  renderJson?: RenderJson;
}

/** A resolved section after its loader ran: component id + enriched props. */
export interface SerializableSection {
  component: string;
  props?: Record<string, unknown>;
}

export interface SerializedSection {
  component: string;
  props: Record<string, unknown>;
}

export interface SerializeOptions {
  /**
   * Resolves a section module by resolveType so the serializer can honor its
   * `renderJson` export. When omitted, every section keeps its full props.
   */
  getSectionModule?: (component: string) => RenderJsonModule | undefined;
  /**
   * App-owned sections excluded from the response, matched by resolveType
   * suffix (e.g. "SeoV2.tsx"). Blank entries are ignored — a "" suffix would
   * endsWith-match every section.
   */
  sectionsToIgnore?: string[];
}

/**
 * Projects a list of eagerly-resolved sections into the lean renderJson shape.
 * A section is dropped when its resolveType matches a `sectionsToIgnore` suffix
 * OR its module exports `renderJson === false`. A `renderJson` function projects
 * the props; otherwise props pass through unchanged.
 */
export function serializeRenderJson(
  sections: SerializableSection[],
  opts: SerializeOptions = {},
): SerializedSection[] {
  const ignore = (opts.sectionsToIgnore ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const renderJsonOf = (component: string): RenderJson | undefined =>
    opts.getSectionModule?.(component)?.renderJson;

  const isDropped = (component: string): boolean =>
    ignore.some((suffix) => component.endsWith(suffix)) ||
    renderJsonOf(component) === false;

  const out: SerializedSection[] = [];
  for (const section of sections) {
    if (isDropped(section.component)) continue;
    const rj = renderJsonOf(section.component);
    const props = typeof rj === "function" ? rj(section.props ?? {}) : section.props ?? {};
    out.push({ component: section.component, props });
  }
  return out;
}
