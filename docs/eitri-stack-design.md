# Supporting the Eitri stack — Design & Plan

> Design + phased plan captured in the 2026-07-14 session. Phase 0 (two spikes:
> schema generation + self-contained `composeMeta`) has been run and is reported
> below; Phases 1–3 are proposed, not yet implemented. Target app:
> `montecarlo-app/eitri-shopping-monte-carlo-shared`.

## Direction (decided 2026-07-14)

`.deco/` becomes the **universal, stack-agnostic filesystem contract**. A
new FS-based Studio (separate epic) reads `.deco/` directly — no stack
renderer involved — and renders the editing UI from it. So our whole job for
Eitri is to **produce a well-filled `.deco`**. Two decisions pin down what
"well-filled" means:

- **`meta.gen.json` must be self-contained.** The FS Studio reads it verbatim
  with no runtime `composeMeta`, so generation must bake the framework
  additions (Page, matchers, `__SECTION_REF__`, `Resolvable`) into the file.
- **Reuse the existing `website/pages/Page.tsx`** as the Eitri page block type
  (a page = `{ name, sections: Section[] }`).

The universal contract is therefore **`meta.gen.json` (self-contained) +
`.deco/blocks/` (the decofile content)**. The per-stack runtime `.gen.ts`
artifacts are NOT part of it (see "Which `.deco` artifacts" below).

## TL;DR

- **Eitri** is a mobile-app platform. Its UI layer, `eitri-luminus`, is a
  DaisyUI-4 **web-React** component library (`View`→div, `Text`→span,
  `Image`→img) that renders inside Eitri's own mobile host.
- Eitri apps already expose `src/sections/**` using **exactly deco's section
  convention**: a default-export component + an exported `Props` interface
  annotated with JSDoc `@title`/`@format`.
- **Decision (2026-07-14): Eitri renders; deco authors config.** deco/Studio
  generates schemas and stores/delivers block config; the Eitri runtime renders
  sections natively. deco does **not** render Eitri pages. This makes the new
  `@decocms/eitri` package a *schema-authoring + config-delivery bridge*, not a
  React rendering binding like `@decocms/nextjs` / `@decocms/tanstack`.
- The framework-agnostic schema generator
  (`packages/blocks-cli/scripts/generate-schema.ts`) **already works** on Eitri
  `.tsx` sections — proven in Phase 0. The remaining work is small, targeted
  runtime enhancements plus a thin package + Studio integration.

## Background: what an Eitri app looks like

`montecarlo-app` is a multi-app Eitri workspace (`app-config.yaml` lists
`shared`, `home`, and commented-out `cart`/`checkout`/`pdp`/`account`). Only the
`shared` app defines `src/sections/**`.

- **No `package.json`, no `tsconfig.json`, no bundler config.** The toolchain is
  the external `eitri-cli` (npm global); dependencies/runtime versions are
  pinned in `eitri-app.conf.js` (`eitri-luminus`, `eitri-bifrost`,
  `eitri-commons`). `check-js: false`.
- Components/views/services are `.jsx`/`.js`; **sections are `.tsx`** (the only
  TS in the app — precisely because sections use a TS `interface Props` as their
  configurable schema).
- Section discovery is filesystem-path-based. During `eitri start` the CLI emits
  a `sections.json` manifest and serves each section from
  `api.eitri.tech/runes-foundry/user/{WORKSPACE_ID}/sections/...`.

Example section (`eitri-shopping-monte-carlo-shared/src/sections/Banners/Hero.tsx`):

```tsx
import { Image, View } from 'eitri-luminus'

export interface Props {
  /** @title Hero image. */
  image: string
  alt?: string
  description?: string
}

export default function HeroBanner({ image, alt, description }: Props) {
  return (
    <View>
      <Image src={image} alt={alt} />
      {description && <p>{description}</p>}
    </View>
  )
}
```

This is byte-for-byte the shape deco's `generate-schema.ts` already parses.

## Why this is NOT a rendering binding

`@decocms/nextjs` and `@decocms/tanstack` are mostly **rendering** glue: they
turn a resolved decofile (`ResolvedSection[]` / `DeferredSection[]`) into HTML
using their framework's server/client/streaming model — `SectionRenderer`,
`DecoPageRenderer`, `DeferredSection`, `DecoRootLayout`, the Cloudflare
`workerEntry`, etc. The non-negotiable interface they implement against is
`@decocms/blocks/cms` (`resolveDecoPage`, the section registry,
`ResolvedSection`/`MatcherContext`) + `@decocms/blocks-admin` (the meta / render
/ invoke handlers).

**Eitri already owns rendering.** Its mobile runtime fetches sections and
renders them via `eitri-luminus`. Trying to have deco render `eitri-luminus`
components would mean porting the entire renderer *and* shimming Eitri's runtime
globals (`Eitri.navigation`, `Eitri.sharedStorage`,
`Eitri.environment.getRemoteConfigs`, auto-injected `Page`/`View`/`Text` +
React hooks). That is a large, fragile effort for no production payoff, since
the mobile host is the real render target.

So for Eitri, deco's job reduces to:

| Concern | nextjs / tanstack | Eitri |
|---|---|---|
| Parse `Props` → JSON Schema (`meta.gen.json`) | ✅ | ✅ **reuse** |
| Serve schema to Studio (`/deco/meta`) | ✅ framework route | ⚠️ needs a home (no deco server) |
| Store block config (decofile) | ✅ | ✅ same |
| **Render pages** | ✅ React SSR | ❌ **Eitri renders natively** |
| Live preview in Studio | ✅ deco renders | ⚠️ open (Eitri preview) |

Everything in the "reimplement per stack" checklist for a rendering binding
(section renderer, page renderer, deferred streaming, root layout, worker/route
entry) **does not apply** to Eitri.

## The schema pipeline is already framework-agnostic

`generate-schema.ts` uses `ts-morph` to parse `Props` interfaces + JSDoc from
`.tsx`/`.ts` under `src/sections`, `src/loaders`, `src/apps`, and emits
`.deco/meta.gen.json` — the `MetaResponse` the `/deco/meta` route serves to
Studio (assembled at runtime by `composeMeta`,
`packages/blocks/src/cms/schema.ts:997`). It anchors output on `process.cwd()`
and hard-requires a `tsconfig.json`.

- JSDoc tags → JSON-Schema keywords via `applyJsDocToSchema`
  (`generate-schema.ts:151`); `@title`/`@format`/etc. pass through, numeric/
  boolean tags coerced.
- Widget aliases → `format` via `WIDGET_TYPE_FORMATS` (`generate-schema.ts:210`):
  `TextArea→textarea`, `DateTimeWidget→date-time`, `ImageWidget→image-uri`, …

The other generators (`generate-sections`, `generate-blocks-manifest`,
`generate-loaders`, `generate-invoke`) emit **React/Vite/Next-specific runtime
glue** (`React.ComponentType` maps, static `.tsx` imports, TanStack Start server
fns). Eitri needs **none** of these — only `generate-schema`.

## Phase 0 — spike results (DONE, 2026-07-14)

Added a minimal `tsconfig.json` to
`eitri-shopping-monte-carlo-shared/` and ran:

```bash
cd eitri-shopping-monte-carlo-shared
tsx <blocks-cli>/scripts/generate-schema.ts \
  --sections src/sections --skip-apps \
  --platform eitri --namespace site --site montecarlo
```

Result: `.deco/meta.gen.json` generated cleanly — 2 sections discovered, props
extracted correctly:

- `site/sections/Banners/Hero.tsx` → `image` (required, title "Hero image."),
  `alt`, `description`.
- `site/sections/Post.tsx` → `photo`, `post` (**`format: "textarea"` ✅**),
  `datetime` (**`format: "datetime"` ⚠️**), `title`; required `post`,
  `datetime`, `title`.

The spike confirms the pipeline works on Eitri sections with nothing but a
tsconfig, and empirically surfaces two gaps (below). `eitri-luminus` not being
installed was a non-issue: `Props` fields are primitives, so ts-morph never
needs to resolve the component-body imports.

### Spike 2 — self-contained meta via `composeMeta` (DONE, 2026-07-14)

To validate the "self-contained `meta.gen.json`" decision, `composeMeta`
(`packages/blocks/src/cms/schema.ts:997`) was run standalone over the generated
`siteMeta` (it is effectively pure — it merges static builder outputs). Result
written to `.deco/meta.composed.json`:

```
BEFORE (generate-schema only): 8 defs,  0 pages, 0 matchers
AFTER  (+ composeMeta):        29 defs, 2 page entries, 16 matchers,
                               __SECTION_REF__ ✓, Resolvable ✓,
                               page block key: website/pages/Page.tsx ✓
```

This proves the whole approach: `composeMeta` injects exactly the framework
definitions an FS-only Studio needs to author pages — including the
`website/pages/Page.tsx` type we chose to reuse. So making `meta.gen.json`
self-contained is a small change: run `composeMeta` at generation time before
writing (see Phase 1). One caveat: `composeMeta` hard-codes
`framework: "tanstack-start"` (`schema.ts:1033`); parameterize it for `eitri`.

## The decofile format (`.deco/blocks/`)

Confirmed against real sites (`storefront-tanstack`, `farmrio`). Each
`.deco/blocks/<encoded-name>.json` is one block instance = its configured props
plus a `__resolveType` naming its block type:

```jsonc
// a section instance
{ "banners": [ /* ... */ ], "__resolveType": "site/sections/Category/CategoryBanner.tsx" }
// a matcher
{ "desktop": true, "__resolveType": "website/matchers/device.ts" }
```

A **page** is a block whose `sections` is an ordered list of section instances
(inline props) and/or references to saved blocks:

```jsonc
{
  "name": "Home Page",
  "sections": [
    { "__resolveType": "website/sections/Rendering/Lazy.tsx", "section": { "__resolveType": "Header" } },
    { "__resolveType": "site/sections/Images/Carousel.tsx", "images": [ /* ... */ ] }
  ]
}
```

`generate-blocks` merges this directory into the compact `blocks.gen.json`
snapshot the React runtime loads — but the **directory itself is the source of
truth** and the thing Studio reads/writes. For Eitri, `.deco/blocks/` starts
empty (a fresh app has no page compositions yet) and is populated by Studio;
how those page decofiles reach the Eitri device is the delivery epic (Open Q3).

## Which `.deco` artifacts Eitri needs

| Artifact | Universal / Eitri? |
|---|---|
| `meta.gen.json` (schema) | ✅ **Yes** — made *self-contained* via `composeMeta` at gen time |
| `.deco/blocks/*.json` (content) | ✅ **Yes** — the decofile Studio reads/writes |
| `blocks.gen.json` (compact snapshot) | ✅ **Yes** — decided 2026-07-14; the Eitri runtime consumes the bundled snapshot, so keep the `blocks` generator on |
| `blocksManifest.gen.ts`, `sections.gen.ts`, `loaders.gen.ts`, `invoke.gen.ts`, `blocks.gen.ts` | ❌ **No** — React/Vite/Next/TanStack runtime-loading glue; dead weight for Eitri (`blocks.gen.ts` is the Vite load-stub sibling of the snapshot — harmless byproduct if it appears) |

**Delivery to Studio:** the FS reaches Studio via a **running daemon that mounts
the workspace** (the model of `packages/tanstack/src/daemon/`) — not hosting or
upload. So an Eitri daemon (or reuse) exposes `.deco` to the FS-based Studio.

## Gaps to close

1. **No `tsconfig.json`** in Eitri apps — `generate-schema` requires one
   (`generate-schema.ts:851`), and the orchestrator gates the `schema`
   generator on its existence (`generate.ts:629`). The `@decocms/eitri` package
   should ship a base tsconfig (+ an `eitri-luminus` ambient type shim) that
   Eitri apps extend.
2. **`@format` value mismatch.** Eitri authors write `@format datetime`; deco's
   `DateTimeWidget` format is `date-time`. Studio won't recognize `datetime`.
   Need an Eitri-aware format normalization (`datetime`→`date-time`;
   `textarea` already matches). Confirmed live by the spike.
3. **`.jsx`/`.js` sections are skipped.** `findTsxFiles` only collects
   `.tsx`/`.ts` (`generate-schema.ts:823`). Eitri permits `.js`/`.jsx`
   sections. (montecarlo's two sections are `.tsx`, and JS files can't carry a
   TS `Props` interface anyway — so this is a general-support item, not a
   blocker for montecarlo.)
4. **Spurious commerce loaders injected.** Even with `--skip-apps`, the two
   `commerce/loaders/product/extensions/{listingPage,detailsPage}` wrappers are
   emitted unconditionally (`generate-schema.ts:1129`). Noise for a
   non-commerce Eitri app; should be gated off when not a commerce site.
5. **Serving `meta.gen.json` to Studio.** An Eitri app has no deco server, so
   there is no `/deco/meta` route. Studio needs another way to obtain the
   schema (see Open Questions).

### Correction: the generate "path parameter"

It was believed the `generate` command already accepts a path telling it where
to create `.deco`. **It does not.** `parseCliOptions`
(`generate.ts:241`) accepts only `--`-flags and **throws on any positional
argument**; the `.deco/` output root is hard-wired relative to `process.cwd()`.
`--sections-dir` (and friends) set **input** dirs only. Today the *only* way to
relocate `.deco` is to run the process with its working directory set to the
target folder (or call `runGenerate(argv, cwd)` programmatically with a custom
`cwd` — which is how the TanStack Vite plugin does it,
`packages/tanstack/src/vite/plugin.js`). A real `generate <PATH>` / `--root`
flag is proposed in Phase 1 for the monorepo-of-apps ergonomics.

## Proposed plan

### Phase 1 — `blocks-cli` enhancements (the core work)

- **Self-contained `meta.gen.json`** (the headline item, proven by Spike 2):
  run `composeMeta` at generation time before writing, so the output already
  contains Page + matchers + `__SECTION_REF__` + `Resolvable`. Add behind a
  flag (e.g. `--compose` / `--self-contained`), default-on for
  `--platform eitri`. Parameterize `composeMeta`'s hard-coded
  `framework: "tanstack-start"` (`schema.ts:1033`).
- **`@format` normalization** for Eitri (`datetime`→`date-time`, other Eitri
  aliases), behind `--platform eitri` so other stacks are unaffected.
- **`.jsx`/`.js` section scanning** (`generate-schema.ts:823`), degrading
  gracefully when a JS file has no extractable `Props`.
- **Gate the commerce-extension-wrapper injection** (`generate-schema.ts:1129`)
  so it doesn't fire for non-commerce sites.
- **`--root <dir>` (or positional `<PATH>`)** on the `generate` orchestrator to
  set the effective `cwd`, so a monorepo can target each Eitri app folder
  without `cd`. Thread through `buildPlan` / child-process `cwd`.
- For `--platform eitri`, run **only** the `schema` + `blocks` generators
  (self-contained `meta.gen.json` + `blocks.gen.json` snapshot); skip
  `manifest`/`sections`/`loaders`/`invoke`. Note the orchestrator would
  otherwise auto-enable `sections` (the dir exists) — the eitri path must
  suppress it (via `--only schema,blocks` today, or bake `--platform eitri`
  awareness into `buildPlan`). Also ensure `blocks` runs even when
  `.deco/blocks/` is empty (a fresh app) so an empty snapshot is emitted.

### Phase 2 — `@decocms/eitri` package (lean, non-rendering)

Mirror the *lean* Next.js package layout, but include only what Eitri needs:

- `package.json` (raw-TS `exports`, dep on `@decocms/blocks-cli`; **no** React
  rendering deps), `README.md` = the "how to run an Eitri app with the runtime"
  guide.
- A base `tsconfig` + `eitri-luminus`/`eitri-bifrost` ambient type shim that
  Eitri apps extend (closes Gap #1).
- The `eitri`-flavored `generate` entry (self-contained schema, `--platform
  eitri`, format normalization, universal-artifacts-only).
- **No runtime SDK** — decided 2026-07-14 the Eitri platform/client owns the
  device-side glue (fetch the snapshot + map `__resolveType` → local module +
  render). `@decocms/eitri` is purely a `.deco` *producer*.

### Phase 3 — Studio integration, delivery & preview

- Decide how the FS Studio obtains `.deco` (Open Q1).
- Define the decofile → Eitri-device delivery contract (Open Q3).
- Preview via Eitri itself (Open Q2) — deferred.

## Open questions

1. **Preview** — via Eitri itself; Studio will "serve something". Deferred.
   *(No open questions block Phase 1.)*

Resolved since first draft: `.deco` delivery = daemon/workspace mount; snapshot
wanted (keep `blocks` on); meta self-containment via `composeMeta` (proven);
device-side rendering glue is owned by the Eitri platform/client (so
`@decocms/eitri` ships no runtime SDK — it only produces `.deco`).

## Resolved decisions (2026-07-14)

- Eitri renders; deco authors config (not a rendering binding).
- `.deco/` is the universal FS contract; `meta.gen.json` must be self-contained
  (generation runs `composeMeta`) — **proven** by Spike 2.
- Reuse `website/pages/Page.tsx` as the Eitri page block type.
- Eitri artifacts = self-contained `meta.gen.json` + `.deco/blocks/` +
  `blocks.gen.json` snapshot; skip the other React-runtime `.gen.ts` files.
- `.deco` reaches Studio via a **daemon that mounts the workspace** (not
  hosting/upload).

## Artifacts produced this session

- `montecarlo-app/eitri-shopping-monte-carlo-shared/tsconfig.json` (minimal,
  for schema generation).
- `.../.deco/meta.gen.json` — site schema (Spike 1).
- `.../.deco/meta.composed.json` — self-contained schema after `composeMeta`
  (Spike 2 proof; in the real impl this becomes `meta.gen.json` itself).
- This document.
