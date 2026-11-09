# Setting up a site

The shapes below are `examples/tanstack-worker-smoke` in this repo. Copy from there when in doubt:
it builds and runs in CI.

## Packages

- `@decocms/blocks` and `@decocms/tanstack` at the same version. `@decocms/tanstack` takes
  `@decocms/blocks` as a peer (`^8.6.0`), so a second copy of blocks never sneaks in.
- Peers: `@tanstack/react-start` and `@tanstack/react-router` (`>=1.166.0`), `react` 19, and `vite`
  (only for `@decocms/tanstack/vite`).
- Dev: `@cloudflare/vite-plugin`, `@vitejs/plugin-react`, `wrangler`.
- The package's `engines` asks for Node `>=24`.

## `vite.config.ts`

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { decoTanstack } from "@decocms/tanstack/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    react(),
    decoTanstack({ buildHash: process.env.WORKERS_CI_COMMIT_SHA }),
  ],
});
```

`decoTanstack()` adds four things:

- `decoContent()` from `@decocms/blocks/vite`: in `vite dev`, a block saved in the site editor
  reloads open pages.
- `__BUILD_HASH__`: the build's id. `buildHash` when given (cut to 12 characters), else
  `git rev-parse --short=12 HEAD`, else the time. `"dev"` in `vite dev`. Declare it once:
  `declare const __BUILD_HASH__: string;`.
- A browser stub for `node:async_hooks`, so server state never breaks the client build.
- `resolve.dedupe` for React and the TanStack packages, so there is one copy of each.

The package reads no environment variable itself: pass the CI's commit SHA.

## `wrangler.jsonc`

```jsonc
{
  "name": "my-store",
  "main": "./src/worker-entry.ts",
  "compatibility_date": "2026-02-14",
  "compatibility_flags": ["nodejs_compat", "no_handle_cross_request_promise_resolution"]
}
```

`main` is the worker entry, not TanStack's server entry ([`worker-entry.md`](./worker-entry.md)).
`nodejs_compat` is needed: the worker hands values to the render through `AsyncLocalStorage`.
The `deco` CLI also reads `vars.DECO_SITE` from this file when the environment has no `DECO_SITE`.

## The block map: `.deco/index.ts`

One function per block type. The key is the type name saved in content; the function's input type
is what `deco schema` turns into Studio's form.

```ts
import type { Blocks, Seo } from "@decocms/blocks";
import type { BlockDescriptor, ProductHeroProps, PromoBannerProps } from "../src/model";

export default {
  seo: (input: Seo) => input,
  "promo-banner": (input: PromoBannerProps): BlockDescriptor => ({ component: "promo-banner", props: input }),
  "product-hero": (input: ProductHeroProps): BlockDescriptor => ({ component: "product-hero", props: input }),
} satisfies Blocks;
```

The example's blocks return a descriptor (`{ component, props }`) and the route maps it to a
component ([`routes-and-pages.md`](./routes-and-pages.md)). Never rename a saved type name: content
stores it. How to write blocks and their props: `deco-site-authoring` and `deco-cms-schema`.

## `src/cms.ts`

```ts
import { createCMS } from "@decocms/blocks";
import { contentClient } from "@decocms/tanstack/server";
import blocks from "../.deco";
import content from "../.deco/blocks.gen";

export const cms = createCMS({ blocks, content });

// The client for this request: the version, visitor and tests the worker decided.
export const client = (request: Request) => contentClient(cms, request);
```

`createCMS` options (`CMSConfig` in `@decocms/blocks`):

| Option | What it does |
|---|---|
| `blocks` | The block map. Required. |
| `content` | The content module (`.deco/blocks.gen.ts`) or a loader. Use it **or** `site`. |
| `site` | The site's ID in Studio. Content then comes from the delivery CDN at runtime. Passing `content` too throws. |
| `token` | The site token, a secret. Sends telemetry to the hosted collector. Needs `site`. |
| `preview.hosts` | Hosts where draft links preview, besides the ones Studio writes into the release. |
| `preview.draftHosts` | Hosts a draft pointer may point at; replaces the defaults. |
| `interval` | ms between content update checks; minimum 60 000. |
| `telemetry` | Where telemetry goes, or `false`. |

Create the CMS once, at module scope. The SDK reads no environment: the site passes `site` and
`token`. On Workers that is `import { env } from "cloudflare:workers"` (`env.DECO_SITE`, and the
token as a secret).

Create one client per request with `contentClient(cms, request)`. It builds
`cms.client({ version, visitor, experiments, campaigns })` from the headers the worker set, so the
page renders the draft and the tests the worker decided. Without the worker (another entry, a
test), the headers are missing: the release renders and the visitor decides the tests.

## Scripts

```json
{
  "predev": "deco schema && deco content",
  "dev": "vite dev",
  "prebuild": "deco schema && deco content",
  "build": "vite build"
}
```

- `deco schema` turns the types in `.deco/index.ts` into `.deco/schema.gen.json`.
  `deco schema --check` fails when the file is out of date (for CI).
- `deco content` turns `.deco/blocks` into `.deco/blocks.gen.ts`, the module `content` imports.
  A site with `site` set reads its content from the CDN and needs no content module.
- `deco check` checks the content against the schema.

The CLI itself (login, drafts, publish, `schema push`): `deco-site-workflow`.

## The other files

`src/router.tsx`, `src/start.ts`: [`router-and-navigation.md`](./router-and-navigation.md).
`src/routes/__root.tsx`: [`document-and-security.md`](./document-and-security.md).
`src/routes/$.tsx`, `src/page.functions.ts`, `src/open-page.server.ts`:
[`routes-and-pages.md`](./routes-and-pages.md). `src/worker-entry.ts`:
[`worker-entry.md`](./worker-entry.md).

## Checks after setup

```bash
bunx deco schema && bunx deco check
bun run build
```

Then open a page, a URL with no page (404), a redirect from the redirects block, and
`/deco/_liveness` (`OK`).
