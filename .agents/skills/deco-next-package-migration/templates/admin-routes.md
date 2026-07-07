# Admin Routes Template

Worked example derived directly from faststore-fila's `src/sdk/deco/adminRoute.ts` and the App Router route files that mount it. The old `@decocms/start/next` tier exported one function, `createDecoAdminRouteHandlers`, that returned `{ GET, POST, PATCH, DELETE }` from a single internal dispatcher routing on `req.url`. `@decocms/next` has no equivalent single dispatcher — it exports one function per admin concern instead, so the site's wrapper becomes a set of thin per-concern re-exports.

## The wrapper: `src/sdk/deco/adminRoute.ts`

```typescript
/**
 * Per-route wrappers around @decocms/next's admin Route Handlers.
 * Each runs ensureSetup() first (so the block registry is populated
 * before handling the request), then delegates. Replaces the single
 * dispatcher `createDecoAdminRouteHandlers` provided — that function has
 * no equivalent on the current package split; @decocms/next's handlers
 * are already split one per concern instead of URL-sniffed from one
 * function.
 */
import {
  decofileGET as decofileGETImpl,
  decofilePOST as decofilePOSTImpl,
  invokePOST as invokePOSTImpl,
  metaGET as metaGETImpl,
  renderGET as renderGETImpl,
  renderPOST as renderPOSTImpl,
} from '@decocms/next'

import { ensureSetup } from './setup'

export async function metaGET(request: Request): Promise<Response> {
  await ensureSetup()
  return metaGETImpl(request)
}

export async function decofileGET(): Promise<Response> {
  await ensureSetup()
  return decofileGETImpl()
}

export async function decofilePOST(request: Request): Promise<Response> {
  await ensureSetup()
  return decofilePOSTImpl(request)
}

export async function invokePOST(request: Request): Promise<Response> {
  await ensureSetup()
  return invokePOSTImpl(request)
}

export async function renderGET(request: Request): Promise<Response> {
  await ensureSetup()
  return renderGETImpl(request)
}

export async function renderPOST(request: Request): Promise<Response> {
  await ensureSetup()
  return renderPOSTImpl(request)
}
```

## Mounting it: App Router route files

Each admin concern gets its own `route.ts` re-exporting the matching wrapper function under the HTTP method(s) it needs. Folder naming here is asymmetric and easy to get backwards: `_`-prefixed folders (e.g. `_meta`, `_healthcheck`) must be URL-encoded as `%5Ffoo`, because Next treats a literal `_folder` as private and excludes it from routing. Dot-prefixed folders (e.g. `.decofile`) must do the opposite — keep the literal dot; the encoded form (`%2E…`) is NOT decoded by Next App Router (verified against Next 16.2.6 / Turbopack) and resolves to the catchall route instead. This is a Next.js routing constraint, unrelated to the package split, but easy to trip over when porting route folders from an old site.

```typescript
// src/app/live/%5Fmeta/route.ts
export const dynamic = 'force-dynamic'
export { metaGET as GET } from 'src/sdk/deco/adminRoute'
```

```typescript
// src/app/.decofile/route.ts
export const dynamic = 'force-dynamic'
export { decofileGET as GET, decofilePOST as POST } from 'src/sdk/deco/adminRoute'
```

```typescript
// src/app/deco/invoke/[[...path]]/route.ts — optional catchall covers both
// `/deco/invoke` and `/deco/invoke/<resolveType>`. Both HTTP methods map to
// the same underlying function.
export const dynamic = 'force-dynamic'
export { invokePOST as GET, invokePOST as POST } from 'src/sdk/deco/adminRoute'
```

```typescript
// src/app/deco/render/route.ts — renders an ad-hoc section by
// __resolveType + props, used by the deco admin UI for live previews.
export const dynamic = 'force-dynamic'
export { renderGET as GET, renderPOST as POST } from 'src/sdk/deco/adminRoute'
```

`renderGET`/`renderPOST` have a second real mount point beyond `/deco/render`: `/live/previews/*` (an optional catchall) is the path `@decocms/next`'s own `renderGET` doc comment calls out as its preview-mode route. Mount the same two functions there too — a future migrator should not assume render handlers live at exactly one URL:

```typescript
// src/app/live/previews/[[...path]]/route.ts
export const dynamic = 'force-dynamic'
export { renderGET as GET, renderPOST as POST } from 'src/sdk/deco/adminRoute'
```

## Routes with no package equivalent

The old dispatcher also served routes that have **no** `@decocms/blocks-admin`/`@decocms/next` equivalent — these were deliberately scoped out of the current package split (live-editing dev tunnel), not omitted by oversight. Delete them or replace with a simple non-daemon stub:

```typescript
// src/app/%5Fwatch/route.ts — DELETE. This served an SSE channel
// streaming file-watch events under `.deco/` to a live-editing admin UI
// (chokidar-based hot reload). No equivalent in the new packages.

// src/app/fs/file/[[...path]]/route.ts — DELETE. JSON-Patch file
// mutation for the same live-editing dev tunnel. No equivalent.
```

```typescript
// src/app/%5Fhealthcheck/route.ts — replace with a plain 200.
// The old dispatcher returned an ADMIN_COMPAT_VERSION string; there's no
// version-negotiation protocol in the new packages, and a bare 200 is
// sufficient for k8s/Cloud Run liveness probes, which don't inspect the
// body.
export const dynamic = 'force-dynamic'

export async function GET() {
  return new Response('ok', { status: 200 })
}
```

```typescript
// src/app/%5Fready/route.ts — replace with a site-authored readiness
// check reading the block registry directly. No shared "readiness"
// helper ships in the new packages; this logic now lives in the site.
import { loadBlocks } from '@decocms/blocks/cms'

import { ensureSetup } from 'src/sdk/deco/setup'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await ensureSetup()
    const blocks = loadBlocks()
    const ready = Object.keys(blocks).length > 0
    return new Response(ready ? 'ready' : 'not ready', { status: ready ? 200 : 503 })
  } catch {
    return new Response('not ready', { status: 503 })
  }
}
```

## Key patterns

1. **One `route.ts` per concern, not one dispatcher.** Each Next.js route file re-exports exactly the wrapper function(s) it needs under the HTTP method name(s) Next.js expects (`GET`, `POST`, etc.) — there's no single `{ GET, POST, PATCH, DELETE }` object to spread across every route anymore.
2. **`ensureSetup()` runs inside every wrapper function, not once at module scope.** The old dispatcher's `onRequest` hook ran it once per dispatched request; the replacement re-implements that per-function since there's no shared dispatcher to hook into.
3. **Don't try to force a package-provided replacement for the deleted dev-tunnel routes.** There isn't one — confirm the site doesn't depend on live in-admin editing before deleting `/_watch` and `/fs/file/*`, and if it does, that's a real capability gap to flag rather than something to work around silently.
4. **Verify route folder naming still resolves after the file changes, and don't apply the same rule to both prefixes.** Renaming/moving these files is a good moment to re-confirm: `_`-prefixed folders need `%5F` encoding, dot-prefixed folders need to stay literal — under the Next.js version in use, encoding a dot-prefixed folder silently reroutes the request to a catchall instead of erroring, so a wrong assumption here fails quietly rather than loudly.
