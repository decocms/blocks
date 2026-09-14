/**
 * Renders a `?renderJson` page by mapping each section's `__resolveType` to a
 * registered native component.
 *
 * This is the native counterpart of `DecoPageRenderer` (`@decocms/tanstack`),
 * and it is a fraction of its size. Almost everything that file does exists to
 * survive server-side rendering, which does not happen on a device:
 *
 * - the sync/lazy bifurcation and the pre-fulfilled-thenable trick dodge
 *   React 19 SSR-streaming hydration bugs — no SSR, no bug;
 * - `<Await>` streaming has no device equivalent (deferred sections are
 *   fetched, not streamed);
 * - `<ClientOnly>` is meaningless when everything is client;
 * - `DeviceProvider` seeds a server-resolved device so SSR and hydration agree;
 *   the device already knows what it is;
 * - the `<section data-manifest-key>` wrappers and the fade-in `<style>` are DOM.
 *
 * It also does **not** need `mergeSections`: the worker already interleaved
 * eager and deferred sections by their CMS index inside `serializeRenderJson`,
 * so `page.sections` arrives in authored order. Re-sorting here would be
 * ceremony.
 *
 * **Container-free by design.** This returns a Fragment, not a ScrollView. The
 * app owns scrolling because it also owns pull-to-refresh, tab bars, sticky
 * headers, and — crucially — viewport detection for deferred sections, which on
 * a device is `FlatList`'s `onViewableItemsChanged` rather than an
 * `IntersectionObserver`. Wrapping here would take that away.
 */

import { getResolvedComponent, getSyncComponent } from "@decocms/blocks/cms/client";
import { SectionErrorBoundary } from "@decocms/blocks/hooks";
import { type ComponentType, createElement, Fragment, type ReactNode } from "react";
import { isDeferred, type SerializedSection } from "./renderJson";

/**
 * `__resolveType` → native component. Matched exactly, then by suffix.
 *
 * `any` on the props mirrors the shared registry (`SectionModule.default` is
 * `ComponentType<any>`): a section is typed by its own Props interface, which
 * the registry cannot know.
 */
export type NativeRegistry = Record<string, ComponentType<any>>;

/** A deferred section the app has since resolved. */
export type ResolvedDeferred = { component: string; props: Record<string, unknown> };

export interface DecoSectionsProps {
  sections: SerializedSection[];
  /**
   * Explicit map, checked before the shared `@decocms/blocks` registry.
   * Suffix matching lets a site register `Images/Banner.tsx` instead of
   * spelling out the `site/sections/` namespace on every key.
   */
  registry?: NativeRegistry;
  /**
   * Deferred sections the app already fetched, keyed by their `lazyUrl`.
   * Anything absent renders `renderPending` instead.
   */
  resolved?: Record<string, ResolvedDeferred>;
  /** Placeholder for a deferred section that has not resolved yet. */
  renderPending?: (section: { component: string; lazyUrl: string }) => ReactNode;
  /** Shown when a section has no registered component. Default: nothing. */
  renderMissing?: (component: string) => ReactNode;
  /** Shown when a section throws. Default: nothing — one section must not blank the page. */
  renderError?: (component: string) => ReactNode;
}

function lookup(component: string, registry?: NativeRegistry): ComponentType<any> | null {
  if (registry) {
    if (registry[component]) return registry[component];
    const suffix = Object.keys(registry).find((key) => component.endsWith(key));
    if (suffix) return registry[suffix];
  }
  // Falls back to the shared registry, so a section registered through
  // `createNativeSetup` works without being listed twice.
  return getSyncComponent(component) ?? getResolvedComponent(component) ?? null;
}

export function DecoSections({
  sections,
  registry,
  resolved,
  renderPending,
  renderMissing,
  renderError,
}: DecoSectionsProps) {
  const render = (component: string, props: Record<string, unknown>, key: string): ReactNode => {
    const Component = lookup(component, registry);
    if (!Component) return <Fragment key={key}>{renderMissing?.(component) ?? null}</Fragment>;
    return (
      // The boundary's own default fallback renders a `<div>`, so an explicit
      // fallback is always passed — that DOM path must never run natively.
      <SectionErrorBoundary
        key={key}
        sectionKey={component}
        fallback={renderError?.(component) ?? null}
      >
        {createElement(Component, props)}
      </SectionErrorBoundary>
    );
  };

  return (
    <Fragment>
      {sections.map((section, index) => {
        // Index is part of the key: the same component can legitimately appear
        // twice on a page (two shelves, two banners).
        const key = `${section.component}-${index}`;

        if (!isDeferred(section)) return render(section.component, section.props, key);

        const hit = resolved?.[section.lazyUrl];
        if (hit) return render(hit.component, hit.props, key);
        return <Fragment key={key}>{renderPending?.(section) ?? null}</Fragment>;
      })}
    </Fragment>
  );
}
