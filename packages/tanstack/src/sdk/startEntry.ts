/**
 * Default TanStack Start entry, supplied by the framework when a site doesn't
 * have its own `src/start.ts`.
 *
 * It exists so that CDN caching of `/_serverFn` is something a site gets from a
 * version bump instead of a per-site PR. The only thing it wires is
 * `decoServerFnFetch`, which appends the cache segment to server-function URLs
 * — see `./cdnSegment` for why that is what makes the CDN key match the
 * Worker's.
 *
 * A site that declares its own `src/start.ts` keeps it: `decoVitePlugin` only
 * aliases this module in when that file is absent. Such a site opts into the
 * CDN behaviour by composing `decoServerFnFetch` itself:
 *
 * ```ts
 * import { decoServerFnFetch } from "@decocms/tanstack/sdk/serverFnFetch";
 * export const startInstance = createStart(() => ({
 *   serverFns: { fetch: decoServerFnFetch },
 * }));
 * ```
 *
 * The export name is load-bearing: `@tanstack/start-client-core`'s
 * `hydrateStart` does `import { startInstance } from "#tanstack-start-entry"`.
 */

import { createStart } from "@tanstack/react-start";
import { decoServerFnFetch } from "./serverFnFetch";

export const startInstance = createStart(() => ({
  serverFns: { fetch: decoServerFnFetch },
}));
