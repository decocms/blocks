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
  /** Position in the page's flat section list (used to interleave with lazy ones). */
  index?: number;
}

/** A deferred section that isn't resolved eagerly — emitted as a lazy placeholder. */
export interface DeferredRef {
  component: string;
  index: number;
}

/** An eager section carries `props`; a lazy one carries a `lazyUrl` to fetch it. */
export type SerializedSection =
  | { component: string; props: Record<string, unknown> }
  | { component: string; lazyUrl: string };

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
  /**
   * Deferred sections to emit as `{ component, lazyUrl }` placeholders,
   * interleaved with the eager ones by `index`. Dropped sections
   * (`renderJson === false` / `sectionsToIgnore`) are omitted here too. When
   * set, the output is ordered by `index`.
   */
  deferred?: DeferredRef[];
  /** Builds the lazy-fetch URL for a deferred section. Required when `deferred` is set. */
  lazyUrlFor?: (ref: DeferredRef) => string;
}

/**
 * Projects a page's sections into the lean renderJson shape. Eager sections
 * become `{ component, props }` (a `renderJson` function projects the props;
 * otherwise props pass through). Deferred sections become
 * `{ component, lazyUrl }`, interleaved by `index`. A section is dropped when
 * its resolveType matches a `sectionsToIgnore` suffix OR its module exports
 * `renderJson === false` (for a deferred section, dropping avoids emitting a
 * lazyUrl the app would fetch for nothing).
 */
/**
 * Keys the section loader / mixins inject into props at request time — page
 * context (`__pageUrl`/`__pagePath`, `runSectionLoaders`) and device
 * (`device`/`isMobile`/`currentSearchParam`, the withDevice/withMobile/
 * withSearchParam mixins). They are request-derived framework internals, NOT
 * content, so they are stripped from the JSON: they would bust the ETag per
 * request/device and leak internals the mobile app shouldn't cache. Any
 * `__`-prefixed key is treated as internal by convention (mirrors `__section`).
 */
const FRAMEWORK_INJECTED_KEYS = new Set(["device", "isMobile", "currentSearchParam"]);

function stripFrameworkKeys(props: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const k of Object.keys(props)) {
    if (k.startsWith("__") || FRAMEWORK_INJECTED_KEYS.has(k)) {
      out ??= { ...props };
      delete out[k];
    }
  }
  return out ?? props;
}

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

  const eager = sections
    .filter((s) => !isDropped(s.component))
    .map((section) => {
      const rj = renderJsonOf(section.component);
      const projected = typeof rj === "function" ? rj(section.props ?? {}) : section.props ?? {};
      const props = stripFrameworkKeys(projected);
      return { index: section.index, out: { component: section.component, props } as SerializedSection };
    });

  // No deferred sections → preserve input order (backward compatible).
  if (!opts.deferred || opts.deferred.length === 0) {
    return eager.map((e) => e.out);
  }

  const lazyUrlFor = opts.lazyUrlFor;
  const lazy = opts.deferred
    .filter((ref) => !isDropped(ref.component) && !!lazyUrlFor)
    .map((ref) => ({
      index: ref.index,
      out: { component: ref.component, lazyUrl: lazyUrlFor!(ref) } as SerializedSection,
    }));

  // Interleave eager + lazy by their position in the page's flat section list.
  return [...eager, ...lazy].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((e) => e.out);
}
