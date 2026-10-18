/**
 * v7's section loader mixins (`@decocms/blocks@7` cms/sectionMixins.ts), with
 * v7's output: loaders that add the device, the mobile flag or the `?q=`
 * search term to a section's props, and `compose` to chain them.
 *
 * ```ts
 * const loaders = {
 *   "site/sections/Product/ProductShelf.tsx": withDevice(),
 *   "site/sections/Images/Carousel.tsx": withMobile(),
 *   "site/sections/Header/Header.tsx": compose(withDevice(), withSearchParam()),
 * };
 * ```
 */
import { detectDevice } from "../device.ts";
import type { SectionLoaderFn } from "./runner.ts";

/**
 * v7 tagged the mixins that read the request, to warn when one served a
 * layout-cached section. There's no layout cache here; the tag is kept so a
 * loader carries the same flag it did on v7.
 */
type TaggedSectionLoaderFn = SectionLoaderFn & { __requestDependent?: boolean };

function tagRequestDependent(fn: SectionLoaderFn): SectionLoaderFn {
  (fn as TaggedSectionLoaderFn).__requestDependent = true;
  return fn;
}

/** Adds `device: "mobile" | "desktop" | "tablet"`, from the request's User-Agent. */
export function withDevice(): SectionLoaderFn {
  return tagRequestDependent((props, req) => ({
    ...props,
    device: detectDevice(req.headers.get("user-agent") ?? ""),
  }));
}

/** Adds `isMobile: boolean` (true for mobile and tablet), from the request's User-Agent. */
export function withMobile(): SectionLoaderFn {
  return tagRequestDependent((props, req) => {
    const d = detectDevice(req.headers.get("user-agent") ?? "");
    return { ...props, isMobile: d === "mobile" || d === "tablet" };
  });
}

const REGEX_QUERY_VALUE = /[?&]q=([^&]*)/;

/**
 * Adds `currentSearchParam: string | undefined`, the URL's first `q=` value,
 * decoded with `decodeURIComponent` (so `+` stays `+`, as on v7).
 */
export function withSearchParam(): SectionLoaderFn {
  return tagRequestDependent((props, req) => {
    const match = req.url.match(REGEX_QUERY_VALUE);
    return {
      ...props,
      currentSearchParam: match ? decodeURIComponent(match[1]) : undefined,
    };
  });
}

/**
 * Chains loaders: each gets the props so far and its result is merged over
 * them, left to right (later ones win).
 */
export function compose(...mixins: SectionLoaderFn[]): SectionLoaderFn {
  const composed: SectionLoaderFn = async (props, req, ctx) => {
    let result = { ...props };
    for (const mixin of mixins) {
      const partial = await mixin(result, req, ctx);
      result = { ...result, ...partial };
    }
    return result;
  };
  if (mixins.some((m) => (m as TaggedSectionLoaderFn).__requestDependent)) {
    (composed as TaggedSectionLoaderFn).__requestDependent = true;
  }
  return composed;
}

/**
 * A section module's own `loader` export as a loader, loaded on first use;
 * put it last in a `compose` so it sees the mixins' props. A module without
 * a `loader` returns the props, and a loader that throws or returns nothing
 * returns them too, as on v7.
 */
export function withSectionLoader(modImport: () => Promise<unknown>): SectionLoaderFn {
  return async (props, req, ctx) => {
    const mod = (await modImport()) as { loader?: unknown } | undefined;
    const loader = mod?.loader;
    if (typeof loader !== "function") return props;
    try {
      const result = await (loader as SectionLoaderFn)(props, req, ctx);
      return result ?? props;
    } catch (error) {
      console.error("[withSectionLoader] section loader threw:", error);
      return props;
    }
  };
}
