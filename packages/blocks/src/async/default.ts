/**
 * The async store where `node:async_hooks` isn't there to import (browsers,
 * React Native, edge runtimes). A runtime that exposes `AsyncLocalStorage` as
 * a global (Vercel's edge runtime) still gets one; elsewhere there is none,
 * and `currentClient()` works from the start of a block function, before its
 * first `await`. Picked by the `#async-store` import's `default` condition.
 */
import type { AsyncStore } from "./types.ts";

export function createAsyncStore<T>(): AsyncStore<T> | undefined {
  const Storage = (globalThis as { AsyncLocalStorage?: new () => AsyncStore<T> }).AsyncLocalStorage;
  return typeof Storage === "function" ? new Storage() : undefined;
}
