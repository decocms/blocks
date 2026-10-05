---
name: deco-server-functions-invoke
description: How server functions (invoke) work in TanStack Start storefronts built on @decocms/tanstack — the @decocms/blocks-cli generate-invoke stage that turns @decocms/apps-vtex's invoke.ts into top-level createServerFn declarations in the site's src/server/invoke.gen.ts. Covers why createServerFn must be top-level (the root cause of CORS errors on VTEX calls), the three-layer architecture (apps-vtex pure functions, blocks-cli generator, site invoke.gen.ts + hand-written invoke.ts), Set-Cookie forwarding so the cart keeps its orderForm, and the comparison with deco-cx/deco's Proxy+HTTP invoke. Load when cart/checkout calls hit VTEX from the browser with CORS errors, the cart "forgets" items, an invoke.vtex.actions.X is missing, the generator fails, or you are adding a server action or wiring invoke on a new site.
---

# Deco Server Functions & Invoke

How server-side actions (cart, checkout, newsletter, masterdata) are called from the browser in Deco TanStack Start storefronts.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/problem.md`](./references/problem.md) | CORS errors on add-to-cart, requests going to VTEX instead of `/_serverFn`, or you need to know why a `createServerFn` inside a factory is never transformed (and how to check the transform on a running dev server) |
| [`references/architecture.md`](./references/architecture.md) | You need the three layers (apps-vtex, blocks-cli, site), the hand-written `src/server/invoke.ts` composition pattern ("Layer 3.5"), the deco-cx/deco comparison, or the cost of the extra hop |
| [`references/generator.md`](./references/generator.md) | Running, extending, or debugging `generate-invoke.ts`: CLI flags, how it parses `invoke.ts`, the generated output shape, adding a new action, and generator/output failures |
| [`references/cookie-forwarding.md`](./references/cookie-forwarding.md) | The cart "forgets" items or `/checkout` opens empty after a successful add — `Set-Cookie` collapse on either bridge |

## The Problem in One Sentence

TanStack Start's `createServerFn` compiler only transforms `.handler()` calls at **module top-level** — wrapping it in a factory function (`createInvokeFn`) causes the compiler's "fast path" to skip it, sending raw VTEX API calls to the browser and causing CORS errors.

## The Solution in One Sentence

A build-time generator (`generate-invoke.ts`, run as the `invoke` stage of `npm run generate`) reads the action definitions from `@decocms/apps-vtex` and emits `invoke.gen.ts` with each `createServerFn().handler()` as a **top-level const**, which the compiler correctly transforms into RPC stubs.

## Quick Reference

```
Client (useCart)
  → invoke.vtex.actions.addItemsToCart({ data: {...} })
  → createClientRpc("base64id")          ← compiler-generated stub
  → POST /_serverFn                         ← same domain, no CORS
  → TanStack Start server handler
  → addItemsToCart(orderFormId, items)    ← pure function from @decocms/apps-vtex
  → vtexFetch → VTEX API                  ← server-to-server, has credentials
  → Response → client
```

## Layer Responsibilities

| Layer | Package | Role |
|-------|---------|------|
| **Commerce functions** | `@decocms/apps-vtex` (`packages/apps-vtex/` in this repo) | Pure async functions (`addItemsToCart`, `subscribe`, etc.) — no framework deps |
| **Generator** | `@decocms/blocks-cli` (`packages/blocks-cli/` in this repo) | `generate-invoke.ts` script that creates top-level `createServerFn` declarations |
| **Generated bridge** | Site (`invoke.gen.ts`) | Auto-generated file with RPC-transformable server functions for the canonical VTEX action set |
| **Site composition (hand-written)** | Site (`invoke.ts`) | Merges generated `vtexActions` with site-specific server functions; see `references/architecture.md`'s "Layer 3.5" |
| **Consumer** | Site components/hooks | Import `invoke` from `~/server/invoke` (the hand-written composition file, not `invoke.gen` directly) |

`@decocms/blocks-cli` is one of the packages this framework split into from the old single `@decocms/start` package (see root `CLAUDE.md`) — `@decocms/blocks`, `@decocms/blocks-admin`, `@decocms/blocks-cli`, `@decocms/tanstack`, `@decocms/nextjs`, plus the `@decocms/apps-*` commerce apps. Every path below reflects that split.

## Setup for a New Site

```bash
# 1. Generate the invoke file (canonical VTEX actions) — the orchestrator's
#    invoke stage; the standalone script still runs by path for debugging:
#    npx tsx node_modules/@decocms/blocks-cli/scripts/generate-invoke.ts
npm run generate

# 2. Hand-write src/server/invoke.ts merging generated + site-specific actions
#    (see references/architecture.md's "Layer 3.5" for the full pattern)

# 3. Import in components
import { invoke } from "~/server/invoke";
const cart = await invoke.vtex.actions.addItemsToCart({
  data: { orderFormId, orderItems }
});
```

Add to `package.json`:
```json
{
  "scripts": {
    "generate": "tsx node_modules/@decocms/blocks-cli/scripts/generate.ts --site <site>",
    "build": "npm run generate && tsr generate && vite build"
  }
}
```

## Key Files

| File | Location | Purpose |
|------|----------|---------|
| `generate-invoke.ts` | `@decocms/blocks-cli/scripts/` (source: `packages/blocks-cli/scripts/generate-invoke.ts`) | Build-time generator script |
| `invoke.gen.ts` | Site `src/server/` | Generated file — canonical VTEX server functions, do not hand-edit |
| `invoke.ts` | Site `src/server/` | Hand-written — merges `vtexActions` from `invoke.gen.ts` with site-specific actions; this is what components import |
| `invoke.ts` | `@decocms/apps-vtex` (`packages/apps-vtex/src/invoke.ts`) | Source of truth for action definitions (parsed by generator) |
| `actions/*.ts` | `@decocms/apps-vtex/actions/*` | Pure commerce functions |

**Two `invoke.ts`-shaped files, two different authoring rules**: `invoke.gen.ts` is regenerated, never hand-edited. `invoke.ts` is hand-written and never regenerated — its authoring pattern (`.inputValidator()`, `Promise<any>` return type, stripping non-serializable fields) is documented in the `deco-to-tanstack-migration` skill's `references/server-functions/README.md` (lives in decocms/migrations). These are not competing/conflicting approaches — codegen handles the bulk canonical VTEX surface, the hand-written file is the documented extension point layered on top. See `references/architecture.md` and `references/generator.md` for the full mechanics.

## When to Re-generate

Re-run `npm run generate` when:
- Adding new actions to `packages/apps-vtex/src/invoke.ts`
- Changing action signatures (input types, return types)
- Updating the `@decocms/apps-vtex` dependency
