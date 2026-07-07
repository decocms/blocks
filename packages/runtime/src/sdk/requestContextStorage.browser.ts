/**
 * Browser-bundle stand-in for the `node:async_hooks`-backed request storage in
 * `./requestContextStorage`. Selected automatically by bundlers that set the
 * `"browser"` export condition (Next.js / webpack client compiler, Vite client
 * build) via the conditional `exports` entry in `packages/runtime/package.json`.
 *
 * There is no per-request async context on the client, so this backend simply
 * reports "no active store". Every `RequestContext` accessor built on top of it
 * therefore behaves exactly as the real implementation does when called outside
 * a request scope:
 *   - `RequestContext.current` / `requestId` → `null`
 *   - `RequestContext.request` / `signal` / `responseHeaders` → throw
 *   - `RequestContext.device` → `"desktop"`, `isBot` → `false`, `elapsed` → `0`
 *   - `RequestContext.fetch` → falls back to `globalThis.fetch`
 *
 * That is exactly the fall-through the sole client-reachable consumer
 * (`resolveDeviceFromRuntime` in `./useDevice`) relies on: `current === null`
 * → use the `navigator.userAgent` client path. Nothing on the client ever
 * establishes a request scope, so `run()` never needs real async propagation —
 * it just invokes the callback inline.
 *
 * `RequestContextStorageBackend` is imported `type`-only from the real
 * `./requestContextStorage` module — this is erased entirely at compile time
 * (by tsc and by the SWC pass Next.js runs before webpack ever sees the
 * module graph), so it does NOT drag `node:async_hooks` back into this file's
 * runtime output. Annotating `storage` with it means this stub and the real
 * `AsyncLocalStorage`-backed implementation are compiler-checked against the
 * exact same narrow surface — if one drifts (e.g. `requestContext.ts` starts
 * calling a method neither backend exposes), `tsc` fails here, not silently
 * at runtime on the client.
 */

import type { RequestContextData } from "./requestContext";
import type { RequestContextStorageBackend } from "./requestContextStorage";

export const storage: RequestContextStorageBackend = {
  getStore(): RequestContextData | undefined {
    return undefined;
  },
  run<R>(_store: RequestContextData, fn: () => R): R {
    return fn();
  },
};
