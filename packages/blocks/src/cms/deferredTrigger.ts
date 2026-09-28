/**
 * Client-safe reader for the deferred-section trigger mode.
 *
 * Lives in its own module — with zero imports — so a browser bundle can reach
 * it without dragging in `resolve.ts` (and its `node:async_hooks` /
 * `node:fs/promises` chain). Same reasoning as `cms/client.ts`; see the header
 * comment there.
 *
 * The value itself is written by `setAsyncRenderingConfig()` in `resolve.ts`,
 * into the same `globalThis.__deco.asyncConfig` bag the server reads. Sites run
 * their `setup.ts` on both sides, so the config is already present on the
 * client by the time a deferred wrapper mounts.
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
