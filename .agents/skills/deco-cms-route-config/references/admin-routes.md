# Admin protocol routes (`/deco/meta`, `/deco/render`, `/deco/invoke`)

These routes enable the Deco CMS admin (admin.deco.cx) to communicate with the storefront:

### Meta Route — Schema & Manifest

```typescript
// src/routes/deco/meta.ts
import { createFileRoute } from "@tanstack/react-router";
import { decoMetaRouteConfig } from "@decocms/tanstack";

export const Route = createFileRoute("/deco/meta")(decoMetaRouteConfig());
```

### Render Route — Section Preview

```typescript
// src/routes/deco/render.ts
import { createFileRoute } from "@tanstack/react-router";
import { decoRenderRouteConfig } from "@decocms/tanstack";

export const Route = createFileRoute("/deco/render")(decoRenderRouteConfig());
```

### Invoke Route — Loader/Action Execution

```typescript
// src/routes/deco/invoke.$.ts
import { createFileRoute } from "@tanstack/react-router";
import { decoInvokeRouteConfig } from "@decocms/tanstack";

export const Route = createFileRoute("/deco/invoke/$")(decoInvokeRouteConfig());
```

### Important: Factories Only — Never Share a Config Object (dev-HMR footgun)

From 7.10.0 the admin routes are exported ONLY as the `*RouteConfig()` factories. On ≤7.9.0 the exports were module-scope literals (`decoMetaRoute`, `decoRenderRoute`, `decoInvokeRoute`) instead — removed because passing one directly to `createFileRoute` bricked dev HMR:

```typescript
// BAD (≤7.9.0 pattern; the import no longer exists from 7.10.0) — bricks
// dev HMR: router-core's update() mutates the SHARED literal (Object.assign
// injects id/path); the first execution pollutes it, and any HMR partial
// re-execution of this file then throws
// "Route cannot have both an 'id' and a 'path' option" — every route 500s
// until the dev server restarts.
export const Route = createFileRoute("/deco/meta")(decoMetaRoute);

// GOOD — factory returns a fresh object per call (7.10.0+)
export const Route = createFileRoute("/deco/meta")(decoMetaRouteConfig());

// Historical: stuck on ≤7.9.0 (only the literals exist there)? Spread the
// literal into a new object:
export const Route = createFileRoute("/deco/meta")({ ...decoMetaRoute });
```

The same rule applies to any route options you build yourself: never let two `createFileRoute` calls (or two executions of the same file) share one options object.


## Common errors

### `Route cannot have both an 'id' and a 'path' option`

A route file passed a shared config object by reference (e.g. the ≤7.9.0 pattern `createFileRoute("/deco/meta")(decoMetaRoute)`) and dev HMR re-executed it against the now-mutated object. Use the factory (`decoMetaRouteConfig()`, the only exported form since 7.10.0); on ≤7.9.0 spread the literal: `{ ...decoMetaRoute }`. Restart the dev server once after fixing — the polluted module stays cached until then.
