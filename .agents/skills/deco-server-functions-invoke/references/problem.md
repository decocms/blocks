# The CORS Problem — Root Cause Analysis

## Symptom

When clicking "Add to Cart" or "Compra Rápida" in a Deco TanStack Start storefront running on `localhost:5173`, the browser makes a direct request to `https://{account}.vtexcommercestable.com.br/api/checkout/pub/orderForm/...`, which fails with a CORS error because the VTEX API doesn't allow cross-origin requests from `localhost`.

## Expected Behavior

The `invoke.vtex.actions.addItemsToCart()` call should go through TanStack Start's server function mechanism:
1. Client calls the function
2. TanStack Start serializes the call and POSTs to `/_serverFn` (same domain)
3. Server deserializes, runs the handler (which calls VTEX API server-to-server)
4. Server returns the result to the client

## Root Cause: Compiler Fast Path

TanStack Start uses a Vite plugin (`tanstack-start-core::server-fn`) that transforms `createServerFn().handler()` calls. On the **client bundle**, it replaces the handler body with a `createClientRpc()` stub that makes an HTTP call to `/_serverFn`.

The compiler has two code paths:

### Fast Path (ServerFn only)
When a file only contains `ServerFn` kind (detected by `/\bcreateServerFn\b|\.\s*handler\s*\(/`), the compiler uses a fast path that **only scans top-level statements**:

```typescript
// compiler.ts — fast path
function areAllKindsTopLevelOnly(kinds: Set<LookupKind>): boolean {
  return kinds.size === 1 && kinds.has('ServerFn')
}

// Only visits top-level VariableDeclarators
// VariableDeclarator -> VariableDeclaration -> Program
```

### Normal Path
For files with multiple kinds (Middleware, IsomorphicFn, etc.), it does a full AST traversal.

## Why createInvokeFn Fails

The factory lives at `packages/tanstack/src/sdk/createInvoke.ts` in this monorepo (moved there from the old single-package `@decocms/start` when the framework split into `runtime`/`admin`/`cli`/`tanstack`/`next` — see the root `README.md`). It is deliberately **not** re-exported from the `@decocms/tanstack` root barrel — importing it there would put a non-top-level `createServerFn(...).handler(...)` into every site's module graph, and the Start compiler throws "createServerFn must be assigned to a variable!" on any such occurrence, called or not (see the comment at the bottom of `packages/tanstack/src/index.ts`). It is public at the dedicated subpath `@decocms/tanstack/sdk/createInvoke`, which is what `@decocms/apps-vtex`'s `invoke.ts` imports. It exists as the source-of-truth *shape* that `generate-invoke.ts` statically parses (never imports) to emit real top-level declarations — never call it from site code that the Start compiler processes.

```typescript
// packages/tanstack/src/sdk/createInvoke.ts (not publicly exported)
import { createServerFn } from "@tanstack/react-start";

export function createInvokeFn(action, opts) {
  return createServerFn({ method: "POST" }).handler(async (ctx) => {
    const result = await action(ctx.data);
    // ...
  });
}
```

The file contains `createServerFn` → triggers `ServerFn` detection → **fast path activates** → only scans top-level → `.handler()` is inside `createInvokeFn` function body → **skipped**.

Result: the client bundle receives the raw code, `createServerFn` returns a function that calls `vtexFetch` directly in the browser.

## Verification

You can verify the transformation by fetching the module from Vite dev server:

```bash
# BROKEN — raw code, no transformation
curl "http://localhost:5173/@fs/.../createInvoke.ts"
# Shows: createServerFn({ method: "POST" }).handler(async (ctx) => { ... })

# FIXED — compiler transformed to RPC
curl "http://localhost:5174/src/server/invoke.gen.ts"  
# Shows: createServerFn({ method: "POST" }).handler(createClientRpc("eyJ..."))
```

The `createClientRpc("base64id")` is the RPC stub — it serializes the call and POSTs to `/_serverFn`.

## The Fix

Each `createServerFn().handler()` must be a **top-level const declaration**:

```typescript
// WORKS — top-level const
const $addItemsToCart = createServerFn({ method: "POST" })
  .handler(async (ctx) => {
    return await addItemsToCart(ctx.data.orderFormId, ctx.data.orderItems);
  });

// DOES NOT WORK — inside a function
function createInvokeFn(action) {
  return createServerFn({ method: "POST" })
    .handler(async (ctx) => { ... });  // ← skipped by fast path
}
```

## Compiler Source Reference

The relevant code is in `@tanstack/start-plugin-core/src/start-compiler-plugin/`:

- `compiler.ts:88-95` — `KindDetectionPatterns.ServerFn = /\bcreateServerFn\b|\.\s*handler\s*\(/`
- `compiler.ts:226-228` — `areAllKindsTopLevelOnly` returns true for ServerFn-only files
- `compiler.ts:660-663` — `canUseFastPath` check
- `compiler.ts:715-717` — early exit when no top-level candidates found
- `plugin.ts:239-247` — transform filter: `id.include = /\.[cm]?[tj]sx?($|\?)/`, `code.include` from `KindDetectionPatterns`

# Diagnosing it on a running site

## CORS Error on Add to Cart / Checkout

**Symptom**: Browser console shows CORS error when calling VTEX API directly.

**Check**: Open browser DevTools → Network tab. If you see requests going to `vtexcommercestable.com.br` instead of `/_serverFn`, the server functions aren't transformed.

**Fix**: 
1. Verify `invoke.gen.ts` exists in `src/server/`
2. Verify component/hook imports point to `~/server/invoke` (the hand-written composition file — see `architecture.md`'s "Layer 3.5"), not directly to `packages/apps-vtex/src/invoke.ts` or `~/server/invoke.gen`
3. Re-run `npm run generate`
4. Restart the dev server (Vite caches transforms)

## Verify Transformation

Fetch the generated file from Vite to see if the compiler transformed it:

```bash
# Replace port with your dev server port
curl "http://localhost:5173/src/server/invoke.gen.ts" | head -20
```

**Good** — you should see `createClientRpc`:
```js
const $addItemsToCart = createServerFn({ method: "POST" })
  .handler(createClientRpc("eyJmaWxlIjoi..."));
```

**Bad** — you see the raw handler code:
```js
const $addItemsToCart = createServerFn({ method: "POST" })
  .handler(async (ctx) => {
    const result = await addItemsToCart(ctx.data.orderFormId, ...);
```

If you see the raw code, the compiler didn't transform it. Possible causes:
- The file is not in `src/` (must be inside the site's source directory)
- The Vite plugin is not loaded (check `vite.config.ts` has `tanstackStart()`)
- The `createServerFn` is not at top-level (check the generated code)

## Telling server-side calls from browser-direct calls

The VTEX client does not log each request, so an empty terminal proves nothing. Use the browser DevTools **Network** tab while clicking add to cart:

- Requests to `/_serverFn/...` on your own origin → the RPC path works (VTEX is called server-to-server).
- Requests to `*.vtexcommercestable.com.br` / `*.myvtex.com` / `/api/checkout/...` on the VTEX host → the call runs in the browser.

**Fix** for the second case: same as the CORS fix above — ensure `invoke.gen.ts` is being used.
