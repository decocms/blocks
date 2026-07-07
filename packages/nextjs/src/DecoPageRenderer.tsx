import type { DeferredSection, ResolvedSection } from "@decocms/blocks/cms";
import { resolveDeferredSection } from "@decocms/blocks/cms";
import { SectionRenderer } from "./SectionRenderer";
import { DeferredSectionBoundary } from "./DeferredSection";
import { cloneElement, type ReactElement, type ReactNode } from "react";

interface DecoPageRendererProps {
  sections: ResolvedSection[];
  deferredSections?: DeferredSection[];
  pagePath: string;
  pageUrl?: string;
  loadingFallback?: ReactNode;
  errorFallback?: ReactNode;
}

type PageItem =
  | { type: "eager"; section: ResolvedSection; sort: number }
  | { type: "deferred"; deferred: DeferredSection; sort: number };

function mergeSections(resolved: ResolvedSection[], deferred: DeferredSection[]): PageItem[] {
  const items: PageItem[] = [];
  resolved.forEach((section, i) => items.push({ type: "eager", section, sort: section.index ?? i }));
  for (const d of deferred) items.push({ type: "deferred", deferred: d, sort: d.index });
  items.sort((a, b) => a.sort - b.sort);
  return items;
}

/**
 * Top-level renderer for a resolved CMS page. Kicks off (but does not await)
 * each deferred section's resolve promise immediately, so they resolve
 * concurrently with the eager sections' own rendering — React's streaming
 * SSR then flushes each <Suspense> boundary as its promise settles.
 */
export async function DecoPageRenderer({
  sections,
  deferredSections = [],
  pagePath,
  pageUrl,
  loadingFallback,
  errorFallback,
}: DecoPageRendererProps) {
  const items = mergeSections(sections, deferredSections);

  // `resolveDeferredSection`'s real signature (packages/blocks/src/cms/resolve.ts)
  // takes positional args `(component, rawProps, pagePath, matcherCtx?)` and
  // returns a `ResolvedSection` WITHOUT `index` set — unlike the object-shaped
  // call the plan sketch assumed. `pageUrl` isn't a direct parameter either; it
  // flows in via `matcherCtx.url`, mirroring how the TanStack route loader
  // builds `matcherCtx` for `loadDeferredSection` (packages/tanstack/src/routes/cmsRoute.ts).
  // We also stamp `index` onto the resolved section ourselves (mirroring what
  // `resolveDeferredSectionFull` does) so downstream consumers can rely on it.
  const matcherCtx = pageUrl ? { url: pageUrl } : undefined;
  const deferredPromises = new Map<number, Promise<ResolvedSection | null>>();
  for (const d of deferredSections) {
    deferredPromises.set(
      d.index,
      resolveDeferredSection(d.component, d.rawProps ?? {}, pagePath, matcherCtx).then((resolved) => {
        if (!resolved) return null;
        return { ...resolved, index: d.index };
      }),
    );
  }

  // Eager sections are resolved via a direct (awaited) function call rather
  // than nested as a `<SectionRenderer />` JSX child. `SectionRenderer` is an
  // async function; Next's real RSC renderer awaits async components nested
  // anywhere in the tree, but that's specific to the RSC streaming renderer —
  // plain `react-dom/server` (used by this package's unit tests, and by any
  // consumer that isn't going through Next's RSC pipeline) throws ("A
  // component suspended while responding to synchronous input") when an async
  // component suspends outside a `<Suspense>` boundary. Deferred sections are
  // deliberately exempt: `DeferredSectionBoundary` wraps its async child in a
  // `<Suspense>`, so letting it suspend there is exactly the intended
  // behavior (renders the fallback synchronously, then streams in later).
  //
  // `deferredPromises` above is already populated before this `Promise.all`
  // runs, so every deferred resolve is in flight concurrently with eager
  // section rendering — nothing here blocks on it.
  const rendered = await Promise.all(
    items.map(async (item): Promise<ReactElement | null> => {
      if (item.type === "eager") {
        const element = await SectionRenderer({
          resolved: item.section,
          errorFallback,
        });
        if (!element) return null;
        return cloneElement(element, { key: `${item.section.key}-${item.section.index}` });
      }
      return (
        <DeferredSectionBoundary
          key={`deferred-${item.deferred.key}-${item.deferred.index}`}
          deferred={item.deferred}
          promise={deferredPromises.get(item.deferred.index)!}
          pagePath={pagePath}
          fallback={loadingFallback}
          errorFallback={errorFallback}
        />
      );
    }),
  );

  return <>{rendered}</>;
}
