/**
 * Work that runs beside requests, never in front of them: release checks and
 * telemetry batches (see /next/hosted-releases-internals and
 * /next/telemetry-internals#sending-in-the-background).
 *
 * Where it runs, in order:
 * - a host hook a framework binding installs under {@link BACKGROUND_HOOK}
 *   (Cloudflare Workers, which run no timers between requests, run the task
 *   after the response inside `ctx.waitUntil`);
 * - `requestIdleCallback` (browsers, React Native);
 * - `scheduler.postTask({ priority: "background" })`;
 * - an unref'd `setTimeout` (so Node never stays alive for it), then
 *   `setImmediate` where it exists.
 *
 * A task never throws into its caller: errors and rejections are swallowed.
 */

/** Where a binding installs `(task) => void` to run background work its own way. */
const BACKGROUND_HOOK = Symbol.for("decocms.blocks.background");

type Task = () => unknown;

interface BackgroundGlobals {
  [BACKGROUND_HOOK]?: (task: () => Promise<void>) => void;
  requestIdleCallback?: (callback: () => void) => unknown;
  scheduler?: {
    postTask?: (callback: () => void, options: { priority: string }) => Promise<unknown>;
  };
  setImmediate?: (callback: () => void) => unknown;
}

export function runInBackground(task: Task): void {
  const run = async (): Promise<void> => {
    try {
      await task();
    } catch {
      // Background work fails quietly; nothing reaches a request.
    }
  };
  const g = globalThis as BackgroundGlobals;
  const hook = g[BACKGROUND_HOOK];
  if (typeof hook === "function") {
    hook(run);
    return;
  }
  if (typeof g.requestIdleCallback === "function") {
    g.requestIdleCallback(() => void run());
    return;
  }
  if (typeof g.scheduler?.postTask === "function") {
    g.scheduler.postTask(() => void run(), { priority: "background" }).catch(() => {});
    return;
  }
  later(0, () => {
    if (typeof g.setImmediate === "function") g.setImmediate(() => void run());
    else void run();
  });
}

/** `setTimeout` that never keeps a Node process alive. */
export function later(ms: number, callback: () => void): void {
  const timer = setTimeout(callback, ms) as unknown as { unref?: () => void };
  timer?.unref?.();
}

/** Whether a binding installed a background hook (then batches go out after each response). */
export function hasBackgroundHook(): boolean {
  return typeof (globalThis as BackgroundGlobals)[BACKGROUND_HOOK] === "function";
}
