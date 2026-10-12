# Admin Routes and RSC Preview Template

Replace the old `@decocms/start/next` dispatcher with the current
`@decocms/nextjs` catch-all route and a dedicated App Router preview page.
`withDeco` rewrites `/.decofile`, `/live/_meta`, and `/live/previews/*` into
the catch-all; `/deco/invoke/*` and `/deco/render` are directly addressable.

## Protocol catch-all

```typescript
// src/app/deco/[[...deco]]/route.ts
import { createDecoRouteHandlers } from '@decocms/nextjs/routeHandlers'

import { ensureSetup } from 'src/sdk/deco/setup'

export const dynamic = 'force-dynamic'

export const { GET, POST, OPTIONS } = createDecoRouteHandlers({
  setup: ensureSetup,
})
```

Import from the `/routeHandlers` subpath in `route.ts`, never from the root
`@decocms/nextjs` barrel. Route handlers are evaluated against React's
react-server build and have no client bundle; importing the root also pulls
component modules into that graph and can fail at module evaluation.

Keep `dynamic = 'force-dynamic'`: metadata, decofile reloads, invokes, and
previews are request-specific admin operations.

## RSC preview page

Mount the page at the fixed framework path `/deco/preview`. This convention is
not configurable; do not add a site option or mount it somewhere else.

```tsx
// src/app/deco/preview/[[...path]]/page.tsx
import { createDecoPreviewPage } from '@decocms/nextjs'

import { ensureSetup } from 'src/sdk/deco/setup'

export const dynamic = 'force-dynamic'

export default createDecoPreviewPage({ setup: ensureSetup })
```

This page is required for Client Components. The generic admin renderer uses
`react-dom/server.renderToString`; in a Next build, a module marked
`"use client"` is represented on the server by a client-reference proxy that
plain React SSR cannot invoke. The App Router page runs through Next's RSC
renderer instead, so a server section tree can contain Client Components and
retain their hydration metadata.

Do not remove `"use client"` merely to make a preview pass. Leave static
sections and wrappers on the server, but keep a client boundary wherever the
component needs hooks, event handlers, browser APIs, or client-only context.

Preview GETs for `/live/previews/*` redirect to this page with their path and
query string preserved. POST preview requests, including `POST /deco/render`,
retain the legacy plain-HTML handler for protocol compatibility.

## Next configuration

Keep the site wrapped with `withDeco`; it installs the public admin rewrites
and transpiles the raw TypeScript packages:

```javascript
// next.config.js
const { withDeco } = require('@decocms/nextjs/config')

module.exports = withDeco(nextConfig)
```

## Routes with no package equivalent

The old dispatcher also served live-editing daemon routes that remain outside
the current package split:

- Delete `/_watch`, the SSE file-watch channel.
- Delete `/fs/file/*`, the JSON-Patch file mutation endpoint.
- Replace `/_healthcheck` with a plain site-authored liveness response.
- Replace `/_ready` with a site-authored block-registry check.

```typescript
// src/app/%5Fhealthcheck/route.ts
export const dynamic = 'force-dynamic'

export async function GET() {
  return new Response('ok', { status: 200 })
}
```

```typescript
// src/app/%5Fready/route.ts
import { loadBlocks } from '@decocms/blocks/cms'

import { ensureSetup } from 'src/sdk/deco/setup'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await ensureSetup()
    const ready = Object.keys(loadBlocks()).length > 0
    return new Response(ready ? 'ready' : 'not ready', {
      status: ready ? 200 : 503,
    })
  } catch {
    return new Response('not ready', { status: 503 })
  }
}
```

Next treats literal `_folder` route segments as private. Use `%5Ffolder` for
underscore-prefixed public routes. Keep dot-prefixed route folders such as
`.decofile` literal; `%2Edecofile` is not decoded into the intended route.

## Verification

1. Run a production `next build`; development mode does not prove the same
   server/client module boundaries.
2. Register a real interactive `"use client"` section in a preview block.
3. Start the production server and request `/live/previews/<block-key>` with
   redirects enabled.
4. Confirm the first response redirects to `/deco/preview/<block-key>`, the
   final response is 200, and its HTML contains the client section's initial
   markup without an `Attempted to call ... from the server` diagnostic.
