/**
 * The async store on servers with `AsyncLocalStorage` (Node, Bun, Deno, and
 * Workers with `nodejs_compat`), so `currentClient()` survives `await`.
 * Picked by the `#async-store` import's `node`, `workerd`, `bun` and `deno`
 * conditions; the runtime core (`src/v8`) never imports a Node built-in.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AsyncStore } from "./types.ts";

export function createAsyncStore<T>(): AsyncStore<T> | undefined {
  return new AsyncLocalStorage<T>();
}
