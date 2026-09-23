/**
 * The native sibling of `createSiteSetup` (`@decocms/blocks/setup`).
 *
 * The site's setup does six things; the device needs one of them. It is not a
 * smaller version of the same job — it is a different job, because **the device
 * does not resolve the CMS**. The worker does, and hands back finished props
 * over `?renderJson`. So everything the site's setup exists for on the server
 * has no counterpart here:
 *
 * | `createSiteSetup` | native |
 * |---|---|
 * | `sections` glob → registry | ✅ the one thing that carries over |
 * | `blocks` (the decofile snapshot) | ❌ never loaded on-device |
 * | `initPlatform` (VTEX/Shopify boot) | ❌ commerce runs server-side |
 * | `customMatchers` | ❌ matchers run during resolution |
 * | `onResolveError` / `onDanglingReference` | ❌ nothing resolves here |
 * | `productionOrigins` | ❌ URL normalization is a server concern |
 *
 * Bundling `blocks.gen.json` into an app would be actively wrong: it is
 * megabytes of content that goes stale the moment someone publishes in the
 * Studio, and the whole point of `?renderJson` is that content updates without
 * a store release.
 */

import { registerSections } from "@decocms/blocks/cms/client";
import type { NativeRegistry } from "./DecoSections";

export interface NativeSetupOptions {
  /**
   * `__resolveType` → native component.
   *
   * Keys should be full resolveTypes (`site/sections/Images/Banner.tsx`).
   * `DecoSections` also suffix-matches, so a shorter key works, but the full
   * one is what the CMS sends and what `getSyncComponent` looks up.
   */
  sections: NativeRegistry;
}

/**
 * Registers native section components in the shared `@decocms/blocks` registry,
 * so `DecoSections` finds them without being handed an explicit map.
 *
 * The registry is `globalThis`-backed and its only React contact is a
 * type-only `ComponentType` import (erased at compile time) plus a
 * `Symbol.for("react.memo" | "react.forward_ref" | "react.lazy")` check that
 * behaves identically in React Native — it is the same `react` package. So it
 * is reused verbatim rather than forked.
 */
export function createNativeSetup(options: NativeSetupOptions): void {
  registerSections(
    Object.fromEntries(
      Object.entries(options.sections).map(([key, Component]) => [
        key,
        // The registry stores async loaders; native components are already
        // imported, so they are wrapped in a resolved promise.
        () => Promise.resolve({ default: Component }),
      ]),
    ),
  );
}
