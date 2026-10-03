/**
 * Runs `@decocms/blocks` background work (release checks, telemetry batches)
 * after each response, inside `ctx.waitUntil`. Workers run no timers between
 * requests, so the core's timer fallback would never fire or would be bound
 * to a finished request. See /next/hosted-releases-internals and
 * /next/telemetry-internals#sending-in-the-background.
 *
 * The hook is installed once per isolate under the `Symbol.for` key the core
 * looks for; its queue lives on the hook itself, so two copies of this module
 * share one queue.
 */

const HOOK = Symbol.for("decocms.blocks.background");

type Task = () => Promise<void>;
type Hook = ((task: Task) => void) & { queue: Task[] };

function hook(): Hook {
  const g = globalThis as unknown as Record<symbol, Hook | undefined>;
  const existing = g[HOOK];
  if (typeof existing === "function" && Array.isArray(existing.queue)) return existing;
  const queue: Task[] = [];
  const installed = Object.assign((task: Task) => void queue.push(task), { queue });
  g[HOOK] = installed;
  return installed;
}

/** Installs the hook (idempotent): from now on, core background work queues here. */
export function installBackgroundHook(): void {
  hook();
}

/** Runs everything queued so far inside `ctx.waitUntil`. */
export function runBackgroundTasks(ctx: { waitUntil(promise: Promise<unknown>): void }): void {
  const tasks = hook().queue.splice(0);
  if (tasks.length === 0) return;
  ctx.waitUntil(Promise.all(tasks.map((task) => task().catch(() => {}))));
}
