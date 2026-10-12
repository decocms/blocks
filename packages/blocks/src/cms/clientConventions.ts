/**
 * Client-safe half of `applySectionConventions` + site-section registration.
 *
 * Everything here only touches `registry.ts` (section components, loading
 * fallbacks, `clientOnly`, `renderJson`) — nothing imports `resolve.ts`,
 * `sectionLoaders.ts` or any Node built-in, so a browser entry can call it
 * without dragging the CMS resolver, the builtin matchers or the admin/schema
 * registries into the client bundle. `applySectionConventions` (server) calls
 * it first and then adds the resolver-side registrations.
 *
 * Browser entries (`router.tsx` -> `setup.ts`) should call these instead of
 * `createSiteSetup` / `applySectionConventions`; see `./client`.
 */
import {
  registerSection,
  registerSections,
  registerSectionsSync,
  setSectionRenderJson,
} from "./registry";
import type { RenderJson } from "./renderJson";

export interface SectionMetaEntry {
  eager?: boolean;
  neverDefer?: boolean;
  deferred?: boolean;
  cache?: string;
  layout?: boolean;
  sync?: boolean;
  clientOnly?: boolean;
  seo?: boolean;
  hasLoadingFallback?: boolean;
  /** `export const fallbackProps = ["title"]` — props the skeleton may render. */
  fallbackProps?: string[];
  /** `export const renderJson = false` — drop the section from ?renderJson. */
  renderJson?: false;
  /** `export const renderJson = (props) => ...` — a projection fn (in `renderJsons`). */
  hasRenderJson?: boolean;
}

export interface ApplySectionConventionsInput {
  /** Section metadata map from sections.gen.ts */
  meta: Record<string, SectionMetaEntry>;
  /** Sync-imported section modules from sections.gen.ts */
  syncComponents?: Record<string, any>;
  /** LoadingFallback components from sections.gen.ts */
  loadingFallbacks?: Record<string, React.ComponentType<any>>;
  /** renderJson projection functions from sections.gen.ts (?renderJson mobile path) */
  renderJsons?: Record<string, RenderJson>;
  /** Lazy section loaders from import.meta.glob (used for clientOnly/loadingFallback registration) */
  sectionGlob?: Record<string, () => Promise<any>>;
}

/**
 * Register the section glob under the `site/sections/...` keys the CMS uses
 * (`./sections/X.tsx` -> `site/sections/X.tsx`). Same transform `createSiteSetup`
 * applies, exposed here so browser entries can do it without the server graph.
 */
export function registerSiteSections(sections: Record<string, () => Promise<any>>): void {
  const keyed: Record<string, () => Promise<any>> = {};
  for (const [path, loader] of Object.entries(sections)) {
    keyed[`site/${path.slice(2)}`] = loader;
  }
  registerSections(keyed);
}

/**
 * The registry-only subset of `applySectionConventions`: `clientOnly`,
 * `LoadingFallback`, `renderJson` and sync (statically imported) components.
 * Safe in a browser bundle.
 */
export function applyClientSectionConventions(input: ApplySectionConventionsInput): void {
  const { meta, syncComponents, loadingFallbacks, renderJsons, sectionGlob } = input;

  for (const [key, entry] of Object.entries(meta)) {
    if (entry.clientOnly && sectionGlob) {
      const globKey = sectionGlobKey(key, sectionGlob);
      if (globKey) {
        registerSection(key, sectionGlob[globKey] as any, { clientOnly: true });
      }
    }

    if (entry.hasLoadingFallback && loadingFallbacks?.[key] && sectionGlob) {
      const globKey = sectionGlobKey(key, sectionGlob);
      if (globKey) {
        registerSection(key, sectionGlob[globKey] as any, {
          loadingFallback: loadingFallbacks[key],
        });
      }
    }

    // renderJson (?renderJson mobile path): a `= false` opt-out drops the
    // section; a projection function trims its props. Set as a section option so
    // the serializer reads it via getSectionOptions without loading the module.
    if (entry.renderJson === false) {
      setSectionRenderJson(key, false);
    } else if (entry.hasRenderJson && renderJsons?.[key]) {
      setSectionRenderJson(key, renderJsons[key]);
    }
  }

  if (syncComponents && Object.keys(syncComponents).length > 0) {
    registerSectionsSync(syncComponents);
  }
}

function sectionGlobKey(
  sectionKey: string,
  glob: Record<string, () => Promise<any>>,
): string | null {
  const relative = sectionKey.replace("site/sections/", "./sections/");
  if (glob[relative]) return relative;
  const withDot = sectionKey.replace("site/", "./");
  if (glob[withDot]) return withDot;
  return null;
}
