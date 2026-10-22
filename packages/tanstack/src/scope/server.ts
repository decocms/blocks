/**
 * Values `createDecoWorker` hands to the render of the request it is serving
 * (the `__cseg` token and the draft `DecoDocument` publishes), through
 * `AsyncLocalStorage`. The browser build resolves `./browser.ts` instead (the
 * package's `./scope` export is conditional: `workerd` and `node` come before
 * `browser`, because a Workers build turns `browser` on too).
 *
 * One storage per process even if a bundler duplicates this module: it lives
 * on `globalThis` under a registered symbol.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestScope {
  /** The CDN segment token for this request's page (the site's `pageCache` passes it to `render`), or undefined. */
  csegToken?: string;
  /** The draft this request renders (after the worker's host check). */
  draft?: string;
}

const KEY = Symbol.for("decocms.tanstack.requestScope");
const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<RequestScope> | undefined>;
const storage: AsyncLocalStorage<RequestScope> =
  holder[KEY] ?? new AsyncLocalStorage<RequestScope>();
holder[KEY] = storage;

/** Runs `fn` with `scope` as the request's scope. */
export function runInScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The scope of the request being served, or undefined outside one (and in the browser). */
export function currentScope(): RequestScope | undefined {
  return storage.getStore();
}

/** Which implementation this is: the conditional-export test asserts it. */
export const SCOPE_IMPLEMENTATION = "async-local-storage" as "async-local-storage" | "browser-stub";
