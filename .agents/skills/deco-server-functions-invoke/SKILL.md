---
name: deco-server-functions-invoke
description: "Server functions (invoke) on @decocms/tanstack: the @decocms/blocks-cli generate stage that turns @decocms/apps-vtex invoke.ts into top-level createServerFn declarations in the site's src/server/invoke.gen.ts, plus the hand-written src/server/invoke.ts. Use when touching invoke.gen.ts/invoke.ts or invoke.vtex.*, when cart/checkout calls hit VTEX from the browser with CORS errors, the cart forgets items (Set-Cookie not forwarded), an invoke action is missing, createServerFn is not top-level, or the generator fails."
---

# Deco Server Functions & Invoke

How server-side actions (cart, checkout, newsletter, masterdata) are called from the browser in Deco TanStack Start storefronts.

TanStack Start's `createServerFn` compiler only transforms `.handler()` calls at **module top-level**; wrapping one in a factory (`createInvokeFn`) gets skipped, so raw VTEX calls ship to the browser and fail with CORS. The fix is codegen: the `invoke` stage of `npm run generate` (`@decocms/blocks-cli`'s `generate-invoke.ts`) reads the action declarations in `@decocms/apps-vtex`'s `invoke.ts` and emits `src/server/invoke.gen.ts` with one top-level `createServerFn()` per action. The site hand-writes `src/server/invoke.ts` to merge those with its own actions, and components import `invoke` from `~/server/invoke`.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/problem.md`](./references/problem.md) | CORS errors on add-to-cart, requests going to VTEX instead of `/_serverFn`, or you need to know why a `createServerFn` inside a factory is never transformed (and how to check the transform on a running dev server) |
| [`references/architecture.md`](./references/architecture.md) | You need the file map (which `invoke*.ts` is generated vs hand-written), the three layers (apps-vtex, blocks-cli, site), the hand-written `src/server/invoke.ts` composition pattern ("Layer 3.5"), the deco-cx/deco comparison, or the cost of the extra hop |
| [`references/generator.md`](./references/generator.md) | Setting up invoke on a new site, deciding when to re-generate, or running, extending, or debugging `generate-invoke.ts`: CLI flags, how it parses `invoke.ts`, the generated output shape, adding a new action, and generator/output failures |
| [`references/cookie-forwarding.md`](./references/cookie-forwarding.md) | The cart "forgets" items or `/checkout` opens empty after a successful add — `Set-Cookie` collapse on either bridge |
