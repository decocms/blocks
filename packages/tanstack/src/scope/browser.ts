/**
 * The browser's copy of `./server.ts`: the same shape, and no request scope
 * (nothing renders inside a worker request there), so no `node:async_hooks`
 * in the client bundle.
 */
import type { RequestScope } from "./server.ts";

export type { RequestScope };

export function runInScope<T>(_scope: RequestScope, fn: () => T): T {
  return fn();
}

export function currentScope(): RequestScope | undefined {
  return undefined;
}

export const SCOPE_IMPLEMENTATION = "browser-stub" as "async-local-storage" | "browser-stub";
