---
name: deco-tanstack-site
description: "Wiring a TanStack Start site to @decocms/tanstack 8 on Cloudflare Workers: createCMS and the block map (.deco/index.ts), the catch-all route with matchRoute, the page server function and its search params (loaderDeps, decoStringifySearch), createDecoWorker and the worker entry (routes, csp, preload, pageCache hook), createDecoRouter and decoServerFnFetch, DecoDocument (lang, head, Studio bridge) and DecoPreview, the security headers and Studio's CSP, and server functions in place of v7's /deco/invoke (top-level createServerFn().handler(), markPrivate, Set-Cookie). Load it when scaffolding a v8 TanStack site, wiring routes, the router or the worker, or debugging a page that renders, routes, redirects, previews or reloads wrong. Not for v7 sites (@decocms/blocks 7.x: the 7.x branch) or Next.js (deco-nextjs-site)."
---

# Deco TanStack Start site (v8)

A v8 TanStack site is TanStack Start with four pieces from `@decocms/tanstack` around it: the
worker (`/worker`), the router (`/router`), the server-function fetch (`/start`) and the root
document (`/react`). Content comes from `@decocms/blocks`: `createCMS` over the site's block map,
and `matchRoute` to find the page for a URL. Everything else (routes, server functions, the page
cache, commerce code) is the site's own code.

Load this skill when you build or debug that wiring. `examples/tanstack-worker-smoke` in this repo
is a complete app; its files are the shapes shown here. The package README
(`packages/tanstack/README.md`) is the full contract of the worker.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/setup.md`](./references/setup.md) | Starting a site, or checking its files: packages, `vite.config.ts`, `wrangler.jsonc`, `.deco/index.ts`, `src/cms.ts`, scripts |
| [`references/routes-and-pages.md`](./references/routes-and-pages.md) | The catch-all route, `openPage`, redirects and 404s, rendering blocks, the head, search params and filters that don't reach the loader |
| [`references/worker-entry.md`](./references/worker-entry.md) | `src/worker-entry.ts`: what `createDecoWorker` always does, its options, the `routes` escape hatch, drafts and the headers it hands the app |
| [`references/server-functions.md`](./references/server-functions.md) | Replacing `/deco/invoke`, a server function whose code ships to the browser, cookies lost on the way to the browser, per-visitor responses |
| [`references/router-and-navigation.md`](./references/router-and-navigation.md) | `createDecoRouter` options, `Link` and preload, a navigation that fetches twice or not at all, variant switching on a product page |
| [`references/document-and-security.md`](./references/document-and-security.md) | `<html lang>`, the head, `DecoDocument` vs your own document, Studio framing, CSP and security headers |

## The files of a site

| File | What it holds | Import from |
|---|---|---|
| `.deco/index.ts` | The block map: one function per block type | `@decocms/blocks` (`Blocks`) |
| `src/cms.ts` | `createCMS(...)` and the per-request client | `@decocms/blocks`, `@decocms/tanstack/server` |
| `src/open-page.server.ts` | `openPage(href, request)`: route, redirect, resolve | `@decocms/blocks` (`matchRoute`) |
| `src/page.functions.ts` | `loadPage`, the page's server function | `@tanstack/react-start` |
| `src/routes/$.tsx` | The catch-all route that calls `loadPage` | `@tanstack/react-router` |
| `src/routes/__root.tsx` | `DecoDocument` as the root component | `@decocms/tanstack/react` |
| `src/router.tsx` | `getRouter()` with `createDecoRouter` | `@decocms/tanstack/router` |
| `src/start.ts` | `createStart` with `decoServerFnFetch` | `@decocms/tanstack/start` |
| `src/worker-entry.ts` | `createDecoWorker(...)`, `wrangler.jsonc` `main` | `@decocms/tanstack/worker` |

## Rules that hold everywhere

- **Never import `@decocms/tanstack/server` or `/worker` from a component.** They are server-only.
  `/react`, `/router`, `/start` and the root export are safe in the browser.
- **The worker decides the draft, the visitor and the tests once per request.** Read them with
  `contentClient(cms, request)`. Don't add a second draft check.
- **The page server function reads the page's URL, never the request's.** On a client-side
  navigation the request is the `/_serverFn/…` call.
- **Each `createServerFn(...).handler(...)` is a top-level `const`.** Inside a function, TanStack's
  compiler skips it and the handler ships to the browser.
- **Build query strings with `decoStringifySearch`**, not `new URLSearchParams(search)`, which turns
  a repeated key (`filter.size=M&filter.size=L`) into one value (`M,L`).
- **Responsive layout is CSS** (`md:hidden`, `<picture>` with `<source media>`), not a JS device
  branch: a branch must render the same on server and client, and the example page cache keys on
  device, so a branch splits the cache.

## Other skills

- `deco-site-workflow`: the `deco` CLI (`schema`, `check`, `pull`, `push --draft`, `publish`) and
  where content lives.
- `deco-site-authoring`: writing sections, pages and loaders.
- `deco-storefront-caching`: the site's `pageCache` and the CDN.
- `deco-storefront-performance`: slow loaders, payload size, hydration.
- `deco-images-media`: `Image`, `Picture` and `ImageUrlProvider`.
- `deco-apps`: the `@decocms/apps-*` clients (VTEX cart cookies included).
- `deco-v7-to-v8-migration`: moving a v7 site here; its script writes the files above.
