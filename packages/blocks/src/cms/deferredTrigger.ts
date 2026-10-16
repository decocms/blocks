/**
 * Client-safe reader for the deferred-section trigger mode.
 *
 * Lives in its own module — with zero imports — so a browser bundle can reach
 * it without dragging in `resolve.ts` (and its `node:async_hooks` /
 * `node:fs/promises` chain). Same reasoning as `cms/client.ts`; see the header
 * comment there.
 *
 * The value itself is written by `setAsyncRenderingConfig()` in `resolve.ts`,
 * into the same `globalThis.__deco.asyncConfig` bag the server reads.
 *
 * WHERE THE SETTING HAS TO RUN: this is read in the browser, so
 * `setAsyncRenderingConfig()` only takes effect if it runs in a module the
 * client bundle also loads — normally `setup.ts`, imported from `router.tsx`.
 * Set it from server-only code (the worker entry, `server.ts`) and the server
 * defers the section as expected while the client silently falls back to
 * `"intersection"`, which looks exactly like the option being ignored.
 *
 * WHO READS IT: only `@decocms/tanstack` (`DeferredSectionWrapper` in
 * `hooks/DecoPageRenderer.tsx`). It lives here because that is where
 * `AsyncRenderingConfig` lives; in `@decocms/nextjs` it is a no-op.
 */

/**
 * How a deferred (⚡) section decides it's time to fetch its real markup.
 *
 * - `"intersection"` — wait until the skeleton is within 300px of the viewport.
 *   Cheapest, and the default.
 * - `"load"` — fetch as soon as the wrapper mounts, without waiting for scroll.
 *   This is what Deco on Fresh does through `DispatchAsyncRender`'s
 *   `partialTriggerMode: "load"`: the page ships a light skeleton HTML and then
 *   materializes every deferred section right after hydration. Sites migrating
 *   from Fresh need this to keep parity — under `"intersection"` alone, content
 *   below the fold does not exist until the user scrolls, which loses
 *   below-the-fold analytics impressions and leaves the document short.
 *
 * The tradeoff of `"load"` is a request burst: every deferred section fires its
 * serverFn POST in the same commit, on first load and again on every SPA
 * navigation. That is precisely what the rAF + observer path exists to avoid,
 * and it is also exactly what Fresh does — so it is the right default for a
 * migrated site and the wrong one for a page with many heavy deferred sections.
 * The switch is site-wide; a per-section override (honouring the `loading` prop
 * the CMS `Lazy.tsx` wrapper already carries, which the resolver currently
 * discards) would be the finer-grained successor.
 */
export type DeferredTrigger = "intersection" | "load";

export const DEFAULT_DEFERRED_TRIGGER: DeferredTrigger = "intersection";

/**
 * Read the configured trigger. Falls back to `"intersection"` when
 * `setAsyncRenderingConfig()` was never called or omitted the option, so
 * existing sites are not regressed by a framework bump.
 */
export function getDeferredTrigger(): DeferredTrigger {
  const config = (globalThis as any).__deco?.asyncConfig;
  return config?.deferredTrigger ?? DEFAULT_DEFERRED_TRIGGER;
}

/**
 * How far outside the viewport a deferred (⚡) section's skeleton may be when
 * `"intersection"` fetches it — the observer's `rootMargin`.
 *
 * Deco on Fresh's `DispatchAsyncRender` observes with `"200px"`. The default
 * here stays `"300px"` so a framework bump changes nothing; a migrated site
 * that needs Fresh's request timing sets
 * `setAsyncRenderingConfig({ deferredRootMargin: "200px" })`. The 100px matter
 * on a phone: a shelf placed just under a tall product page lands inside a
 * 300px margin on load, and its request goes out before the shopper scrolls.
 */
export const DEFAULT_DEFERRED_ROOT_MARGIN = "300px";

/** Read the configured `rootMargin`, falling back to `"300px"`. */
export function getDeferredRootMargin(): string {
  const config = (globalThis as any).__deco?.asyncConfig;
  return config?.deferredRootMargin ?? DEFAULT_DEFERRED_ROOT_MARGIN;
}
