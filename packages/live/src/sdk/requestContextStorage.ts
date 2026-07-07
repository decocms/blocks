/**
 * Node/Workers implementation of the per-request storage backend for
 * `RequestContext` (see `./requestContext`).
 *
 * This is the ONE module in the `requestContext` graph that touches
 * `node:async_hooks`. It is split out from `requestContext.ts` so that
 * bundlers building for a browser target can swap it for the no-op stub in
 * `./requestContextStorage.browser` via the `"browser"` export condition in
 * `packages/live/package.json` — without that condition, Next.js's client
 * webpack compiler tries to resolve the `node:async_hooks` specifier for a
 * non-Node target and fails the build with `UnhandledSchemeError`, even though
 * `AsyncLocalStorage` is only ever meaningfully used server-side.
 *
 * Requires `nodejs_compat` in wrangler.jsonc (already enabled) on Workers.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContextData } from "./requestContext";

/**
 * The narrow surface `requestContext.ts` actually calls (`storage.getStore()`
 * / `storage.run(ctx, fn)`). Exporting `storage` typed as this interface —
 * rather than letting it infer the full `AsyncLocalStorage<RequestContextData>`
 * type — means `requestContext.ts` only ever sees these two members,
 * regardless of which backend (this file or `./requestContextStorage.browser`)
 * a given bundler's export condition resolves to. If `requestContext.ts` is
 * ever edited to call another `AsyncLocalStorage` method (e.g. `enterWith`,
 * `exit`, `disable`), that becomes an immediate compile error at the call
 * site — forcing whoever adds it to widen this type here AND add the method
 * to the browser stub, instead of silently working against the real backend
 * while quietly breaking on the client.
 */
export type RequestContextStorageBackend = Pick<AsyncLocalStorage<RequestContextData>, "run" | "getStore">;

export const storage: RequestContextStorageBackend = new AsyncLocalStorage<RequestContextData>();
