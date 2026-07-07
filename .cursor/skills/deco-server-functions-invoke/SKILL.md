---
name: deco-server-functions-invoke
description: How server functions (invoke) work in Deco storefronts — the generate-invoke pipeline that bridges @decocms/apps pure functions to TanStack Start createServerFn with top-level declarations. Covers the root cause of CORS issues with VTEX API calls, why createServerFn must be top-level, the three-layer architecture (apps=pure functions, start=generator, site=generated invoke), the generate-invoke.ts script, and the comparison with deco-cx/deco's Proxy+HTTP invoke. Use when debugging CORS in cart/checkout, adding new server actions, understanding why invoke calls hit VTEX directly from the browser, or setting up invoke for a new site.
globs:
  - "**/invoke.gen.ts"
  - "**/invoke.ts"
  - "**/useCart.ts"
  - "**/createInvoke.ts"
  - "**/generate-invoke.ts"
---

## Sub-documents

| Document | Topic |
|----------|-------|
| [problem.md](./problem.md) | The CORS problem — root cause analysis of why createServerFn inside a factory function doesn't work |
| [architecture.md](./architecture.md) | Three-layer invoke architecture and comparison with deco-cx/deco |
| [generator.md](./generator.md) | The generate-invoke.ts script — how it works, how to run it, how to extend |
| [troubleshooting.md](./troubleshooting.md) | Common issues and how to debug them |

# Deco Server Functions & Invoke

How server-side actions (cart, checkout, newsletter, masterdata) are called from the browser in Deco TanStack Start storefronts.

## The Problem in One Sentence

TanStack Start's `createServerFn` compiler only transforms `.handler()` calls at **module top-level** — wrapping it in a factory function (`createInvokeFn`) causes the compiler's "fast path" to skip it, sending raw VTEX API calls to the browser and causing CORS errors.

## The Solution in One Sentence

A build-time generator (`generate-invoke.ts`) reads the action definitions from `@decocms/apps` and emits `invoke.gen.ts` with each `createServerFn().handler()` as a **top-level const**, which the compiler correctly transforms into RPC stubs.

## Quick Reference

```
Client (useCart)
  → invoke.vtex.actions.addItemsToCart({ data: {...} })
  → createClientRpc("base64id")          ← compiler-generated stub
  → POST /_server                         ← same domain, no CORS
  → TanStack Start server handler
  → addItemsToCart(orderFormId, items)    ← pure function from @decocms/apps
  → vtexFetch → VTEX API                  ← server-to-server, has credentials
  → Response → client
```

## Layer Responsibilities

| Layer | Package | Role |
|-------|---------|------|
| **Commerce functions** | `@decocms/apps` (separate repo/package, not in this monorepo) | Pure async functions (`addItemsToCart`, `subscribe`, etc.) — no framework deps |
| **Generator** | `@decocms/cli` (`packages/cli/` in this repo) | `generate-invoke.ts` script that creates top-level `createServerFn` declarations |
| **Generated bridge** | Site (`invoke.gen.ts`) | Auto-generated file with RPC-transformable server functions for the canonical VTEX action set |
| **Site composition (hand-written)** | Site (`invoke.ts`) | Merges generated `vtexActions` with site-specific server functions; see `architecture.md`'s "Layer 3.5" |
| **Consumer** | Site components/hooks | Import `invoke` from `~/server/invoke` (the hand-written composition file, not `invoke.gen` directly) |

`@decocms/cli` is one of five packages this framework split into from the old single `@decocms/start` package (see root `README.md`) — `runtime`, `admin`, `cli`, `tanstack`, `next`. Every path below reflects that split.

## Setup for a New Site

```bash
# 1. Generate the invoke file (canonical VTEX actions)
npx tsx node_modules/@decocms/cli/scripts/generate-invoke.ts

# 2. Hand-write src/server/invoke.ts merging generated + site-specific actions
#    (see architecture.md's "Layer 3.5" for the full pattern)

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
    "generate:invoke": "tsx node_modules/@decocms/cli/scripts/generate-invoke.ts",
    "build": "npm run generate:blocks && npm run generate:invoke && npm run generate:schema && tsr generate && vite build"
  }
}
```

## Key Files

| File | Location | Purpose |
|------|----------|---------|
| `generate-invoke.ts` | `@decocms/cli/scripts/` (source: `packages/cli/scripts/generate-invoke.ts`) | Build-time generator script |
| `invoke.gen.ts` | Site `src/server/` | Generated file — canonical VTEX server functions, do not hand-edit |
| `invoke.ts` | Site `src/server/` | Hand-written — merges `vtexActions` from `invoke.gen.ts` with site-specific actions; this is what components import |
| `vtex/invoke.ts` | `@decocms/apps/` | Source of truth for action definitions (parsed by generator) |
| `vtex/actions/*.ts` | `@decocms/apps/` | Pure commerce functions |

**Two `invoke.ts`-shaped files, two different authoring rules**: `invoke.gen.ts` is regenerated, never hand-edited. `invoke.ts` is hand-written and never regenerated — its authoring pattern (`.inputValidator()`, `Promise<any>` return type, stripping non-serializable fields) is documented in `.agents/skills/deco-to-tanstack-migration/references/server-functions/README.md`. These are not competing/conflicting approaches — codegen handles the bulk canonical VTEX surface, the hand-written file is the documented extension point layered on top. See `architecture.md` and `generator.md` for the full mechanics.

## When to Re-generate

Re-run `npm run generate:invoke` when:
- Adding new actions to `@decocms/apps/vtex/invoke.ts`
- Changing action signatures (input types, return types)
- Updating `@decocms/apps` dependency
