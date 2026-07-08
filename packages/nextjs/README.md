# `@decocms/nextjs`

Deco framework binding for Next.js App Router — the Next.js sibling of
`@decocms/tanstack`. Three surfaces, composed together:

- **`@decocms/nextjs/config`** — `withDeco(nextConfig)`, a `next.config`
  wrapper that adds the rewrites and `transpilePackages` Deco's admin
  protocol needs.
- **`@decocms/nextjs/routeHandlers`** — `createDecoRouteHandlers({ setup })`,
  a single catch-all dispatcher for the whole Studio admin protocol
  (decofile read/reload, meta schema, invoke, live previews).
- **`@decocms/nextjs/setup`** — `createNextSetup(options)`, a one-call site
  bootstrap: the Next.js analogue of Vite's
  `createSiteSetup` + `createAdminSetup` + `import.meta.glob`.

This document is the complete recipe a new Next.js site follows to wire all
three together. Every code block below is meant to be copied, not
paraphrased.

## Install

```bash
bun add @decocms/nextjs @decocms/blocks @decocms/blocks-admin
```

`next`, `react`, and `react-dom` are peer dependencies — the site already
has them.

## 1. `next.config` — `withDeco`

`withDeco` adds three rewrites (mapping the Studio-protocol URLs Next.js
cannot express as route segments onto `/deco/*`, where the catch-all route
below serves them) and appends the three `@decocms/*` packages (which ship
raw TypeScript, not a prebuilt `dist/`) to `transpilePackages`.

TypeScript (`next.config.ts`):

```ts
import type { NextConfig } from "next";
import { withDeco } from "@decocms/nextjs/config";

const nextConfig: NextConfig = {
  // ...your own config
};

export default withDeco(nextConfig);
```

CommonJS (`next.config.js`) — most Next.js sites still use this form:

```js
/** @type {import('next').NextConfig} */
const { withDeco } = require("@decocms/nextjs/config");

const nextConfig = {
  // ...your own config
};

module.exports = withDeco(nextConfig);
```

`withDeco` merges with a `rewrites`/`transpilePackages` you already have —
it never replaces them. If your own `rewrites()` returns the array form,
Deco's rewrites are prepended; if it returns the `{ beforeFiles, afterFiles,
fallback }` object form, Deco's rewrites are prepended to `beforeFiles`.

## 2. The catch-all route

Mount `createDecoRouteHandlers` at `app/deco/[[...deco]]/route.ts` — this
one file serves the entire admin protocol (decofile, meta, invoke, live
previews) for both the rewritten public URLs (`/.decofile`, `/live/_meta`,
`/live/previews/*`) and their `/deco/*` destinations directly.

```ts
// src/app/deco/[[...deco]]/route.ts
import { createDecoRouteHandlers } from "@decocms/nextjs/routeHandlers";
import { ensureSetup } from "../../../deco/setup";

export const dynamic = "force-dynamic";

export const { GET, POST } = createDecoRouteHandlers({ setup: ensureSetup });
```

`dynamic = "force-dynamic"` is required — this route must never be
statically cached (decofile reloads, invoke calls, and previews all need a
fresh response per request).

### Route-handler import rule: subpaths, never the root barrel

**Always import from `@decocms/nextjs/routeHandlers` (or `/config`,
`/setup`) in a `route.ts` file. Never `import { ... } from "@decocms/nextjs"`
there.**

App Router route handlers evaluate their entire module graph against
React's **react-server** build, and this happens regardless of any
`"use client"` directive in that graph — route handlers have no client
bundle to move a `"use client"` module into, so the directive is simply
ignored. The root barrel (`@decocms/nextjs`'s `.` export) re-exports the
render components (`DecoRootLayout`, `SectionRenderer`, `DecoPageRenderer`,
...), whose module graph reaches component code that uses client-only React
APIs (`createContext`, `useContext`, class components with
`componentDidCatch`, etc.) at module scope. Importing the root barrel from
a route file pulls that whole graph into react-server evaluation and
crashes at **import time**, before your handler ever runs, with errors like
`"...createContext is not a function"` or `"Class extends value undefined
is not a constructor"` — even if the route handler itself never touches
those components. The `/routeHandlers`, `/config`, and `/setup` subpaths
are each scoped to keep their own module graph free of component code, so
they're safe to import from anywhere, including a route file.

## 3. `src/deco/setup.ts` — `createNextSetup`

```ts
// src/deco/setup.ts
import { createNextSetup } from "@decocms/nextjs/setup";
import { sectionImports, sectionMeta, syncComponents, loadingFallbacks } from "./sections.gen";

export const ensureSetup = createNextSetup({
  sections: sectionImports,
  conventions: { meta: sectionMeta, syncComponents, loadingFallbacks },
  meta: () => import("./meta.gen.json").then((m) => m.default),
});
```

`createNextSetup` returns a **memoized** `ensureSetup()` function — a
successful bootstrap is cached for the life of the warm serverless
instance; a *rejected* bootstrap clears the memo so the next call retries
from scratch (the triggering call still rejects with the original error).

Two call sites need `ensureSetup()`:

1. **The catch-all route** (above) passes it as `{ setup: ensureSetup }` —
   `createDecoRouteHandlers` awaits it before dispatching every admin
   request.
2. **The root layout** (`app/layout.tsx`) must await it directly before
   rendering, since page rendering (`createDecoPage`'s resolver) has no
   setup hook of its own:

   ```tsx
   // src/app/layout.tsx
   import { DecoRootLayout } from "@decocms/nextjs";
   import { ensureSetup } from "../deco/setup";

   export default async function RootLayout({ children }: { children: React.ReactNode }) {
     await ensureSetup();
     return <DecoRootLayout siteName="my-site">{children}</DecoRootLayout>;
   }
   ```

   (`app/layout.tsx` is a Server Component, not a route handler, so it's
   fine to import the root barrel here — see the rule above.)

### `NextSetupOptions` at a glance

| Option | Purpose |
| --- | --- |
| `blocksDir` | Directory of decofile JSON snapshots (`.deco/blocks` by default). Pass `false` to skip filesystem loading entirely (e.g. when all content comes from `blocks`). |
| `blocks` | Extra/override blocks, merged **over** the directory's blocks. |
| `sections` | The lazy section registry — `sectionImports` from `generate-sections --registry` (see below). |
| `conventions` | `{ meta, syncComponents, loadingFallbacks }` from `sections.gen.ts` — wires the `export const sync/layout/seo/cache/eager/clientOnly` conventions (see below). |
| `meta` | Lazy admin meta schema loader: `() => import("./meta.gen.json").then(m => m.default)`. Wire this even with a trivial schema — without it, `/deco/meta` (and its `/live/_meta` alias) 503s with `"Schema not initialized"`. |
| `renderShell` | Admin preview shell config (`{ css, fonts }`). |
| `previewWrapper` | Admin preview wrapper component. |
| `productionOrigins`, `customMatchers`, `onResolveError`, `onDanglingReference` | Passed through to `createSiteSetup`. |
| `extend` | Site-specific wiring that must run *after* core setup (section loaders, legacy SEO key shims, curated post-processing). Receives the loaded blocks. |

## 4. `package.json` scripts — non-colliding names

Add two codegen scripts. **Do not name either of these `generate:schema`** —
FastStore sites already own that script name for their own commerce-schema
codegen, and a collision silently shadows one of the two generators
depending on script-merge order. Use these names instead:

```json
{
  "scripts": {
    "generate:deco-meta": "tsx node_modules/@decocms/blocks-cli/scripts/generate-schema.ts --out src/deco/meta.gen.json",
    "generate:deco-sections": "tsx node_modules/@decocms/blocks-cli/scripts/generate-sections.ts --registry --out-file src/deco/sections.gen.ts"
  }
}
```

- `generate:deco-meta` runs `blocks-cli`'s `generate-schema.ts`, which scans
  `src/sections/`, `src/loaders/`, and `src/apps/` for `Props` interfaces
  and emits the JSON Schema the admin's `/deco/meta` endpoint serves
  (`meta.gen.json`).
- `generate:deco-sections` runs `generate-sections.ts` **with `--registry`**
  — the flag that additionally emits `sectionImports`, the Next.js/webpack
  equivalent of Vite's `import.meta.glob("./sections/**/*.tsx")` (Next has
  no `import.meta.glob` or Vite plugin, so this is generated instead of
  computed at build time). Without `--registry` you only get
  `sectionMeta`/`syncComponents`/`loadingFallbacks`, not the lazy loader map
  `setup.ts` needs for its `sections` option.

Run both any time `src/sections/` changes (wire into a `predev`/`prebuild`
step, or a watch script, as your site prefers).

## 5. `src/sections/` — the entry-file convention

Every non-test `.tsx`/`.ts` file directly under `src/sections/` (recursively)
becomes a section key, keyed as `site/sections/<path-relative-to-sections-dir>`.
**This is not opt-in** — `generate-sections.ts` walks the whole directory
and turns every matching file into a registry entry, whether or not it
carries any convention exports. Files ending in `.test.ts(x)`, `.spec.ts(x)`,
`.stories.ts(x)`, or `.gen.ts(x)` are the only ones excluded.

The established pattern is a **thin re-export entry file** per section, with
the actual component implementation living elsewhere (e.g. alongside its
own subcomponents, styles, and tests, outside `src/sections/`):

```ts
// src/sections/Hero.tsx — thin entry file, becomes "site/sections/Hero.tsx"
export { default } from "../components/Hero/Hero";
export type { HeroProps as Props } from "../components/Hero/Hero";
```

This keeps `src/sections/` a clean, flat index of exactly what's
CMS-addressable, instead of a directory contest between "real" component
code and registry wiring.

### Convention exports

A section's entry file (or the file it re-exports from — the scanner reads
the entry file's own source, so re-exported `export const` conventions must
be re-declared or forwarded on the entry file itself, not just the
implementation file) can opt into these, each read as a literal
`export const <name> = <value>`:

| Export | Effect |
| --- | --- |
| `export const sync = true` | Bundled synchronously (not lazy-loaded) — for above-the-fold, always-rendered sections. |
| `export const layout = true` | Cached as a layout section (Header, Footer, Theme) — resolved once, not per-page. |
| `export const seo = true` | SEO section — its resolved props are merged into page-level SEO. |
| `export const cache = "listing"` | SWR-cached section loader results, keyed by the given cache name. |
| `export const eager = true` | Prefers eager rendering (defers only past the fold threshold). |
| `export const neverDefer = true` | Always eager, ignoring the fold threshold entirely. |
| `export const clientOnly = true` | Skips SSR — client-only rendering. |
| `export function LoadingFallback` | Skeleton component shown while the section loads. |

## Verifying your setup

`examples/nextjs-smoke` in this monorepo is a minimal, real Next.js App
Router build exercising all three surfaces end to end — `withDeco` rewrites,
the catch-all route, `createNextSetup`, and a resolved page render. Use it
as a working reference if any of the above doesn't compose the way you
expect.
