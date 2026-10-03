/**
 * Work that runs beside requests, never in front of them: release checks and
 * telemetry batches (see /next/hosted-releases-internals and
 * /next/telemetry-internals#sending-in-the-background).
 *
 * Where it runs, in order:
 * - a host hook a framework binding installs under {@link BACKGROUND_HOOK};
 * - on Cloudflare Workers, which run no timers between requests, the
 *   platform's `waitUntil` (from `cloudflare:workers`), so the task runs
 *   after the response with no binding and no user code: the core installs
 *   that hook itself;
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

type WaitUntil = (promise: Promise<unknown>) => void;

/** Workers identify themselves in `navigator.userAgent`. */
function onWorkers(): boolean {
  return (
    (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ===
    "Cloudflare-Workers"
  );
}

/**
 * `cloudflare:workers`, loaded once. The specifier is computed so bundlers
 * for other targets (browsers, Node) never try to resolve it.
 */
let workers: Promise<WaitUntil | undefined> | undefined;
function workersWaitUntil(): Promise<WaitUntil | undefined> {
  const specifier = ["cloudflare", "workers"].join(":");
  workers ??= import(/* @vite-ignore */ /* webpackIgnore: true */ specifier).then(
    (mod: { waitUntil?: WaitUntil }) =>
      typeof mod.waitUntil === "function" ? mod.waitUntil : undefined,
    () => undefined,
  );
  return workers;
}

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
  if (onWorkers()) {
    void workersWaitUntil().then((waitUntil) => {
      if (waitUntil === undefined) return void run();
      // From now on, hand every task straight to the platform.
      if (typeof g[BACKGROUND_HOOK] !== "function") {
        g[BACKGROUND_HOOK] = (next) => waitUntil(next());
      }
      g[BACKGROUND_HOOK]?.(run);
    });
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
