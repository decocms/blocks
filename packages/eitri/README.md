# `@decocms/eitri`

Deco binding for the **Eitri** mobile stack. Unlike `@decocms/nextjs` /
`@decocms/tanstack`, this package does **not** render anything — Eitri renders
sections natively on its own mobile runtime. `@decocms/eitri` only *produces a
well-filled `.deco`* so Studio can author content against your Eitri sections:

- a **self-contained** `.deco/meta.gen.json` (section schemas **plus** the
  framework block types — Page, matchers, `Resolvable`, the section picker —
  baked in, so an FS-based Studio reads it verbatim with no runtime), and
- the bundled `.deco/blocks.gen.json` decofile snapshot the Eitri runtime
  consumes.

It is a thin, Eitri-flavored wrapper over `@decocms/blocks-cli`'s `generate`
orchestrator (`--platform eitri`). See
[`docs/eitri-stack-design.md`](../../docs/eitri-stack-design.md) for the full
design.

## What Eitri owns vs. what deco owns

| | Owner |
|---|---|
| Section `Props` → JSON Schema, decofile snapshot (`.deco`) | **`@decocms/eitri`** (this package) |
| Authoring content (forms, page composition) | Studio (reads `.deco`) |
| Fetching the decofile on-device + rendering sections | **Eitri platform / your app** |

There is intentionally **no runtime SDK** here.

## Sections

An Eitri section is exactly a deco section: a default-exported component in
`src/sections/**` with an exported `Props` interface documented with JSDoc.

```tsx
// src/sections/Banners/Hero.tsx
import { Image, View } from "eitri-luminus";

export interface Props {
  /** @title Hero image. */
  image: string;
  /** @title Alt text. */
  alt?: string;
  /** @title Publish date. @format datetime */
  datetime?: string;
}

export default function HeroBanner({ image, alt }: Props) {
  return <View><Image src={image} alt={alt} /></View>;
}
```

`@title`, `@format` (e.g. `textarea`, `datetime` → normalized to `date-time`),
and the other JSDoc widget tags drive the Studio form. Sections may be `.tsx`,
`.ts`, `.jsx`, or `.js`.

## Install

```bash
# in your Eitri app (as a dev tool)
npm i -D @decocms/eitri
```

## Setup

```bash
npx deco-eitri init
```

This scaffolds (never overwriting existing files):

- `tsconfig.json` extending `@decocms/eitri/tsconfig` — **required**;
  `generate-schema` needs a tsconfig to parse your `Props` types.
- `src/eitri-env.d.ts` — ambient shims for `eitri-luminus` / `eitri-bifrost` so
  your editor and `tsc` don't flag those imports. Purely ergonomic; generation
  works without it. Delete it if you install the real `eitri-luminus` types.

If you prefer to wire it by hand, your `tsconfig.json` need only be:

```json
{ "extends": "@decocms/eitri/tsconfig", "include": ["src"] }
```

## Generate

```bash
# from the app root
npx deco-eitri generate

# or, targeting a sub-app in a monorepo without cd:
npx deco-eitri generate --root eitri-shopping-monte-carlo-shared
```

Add it as a script:

```json
{ "scripts": { "deco:generate": "deco-eitri generate" } }
```

Output under `.deco/`:

- `meta.gen.json` — self-contained schema (`framework: "eitri"`).
- `blocks.gen.json` — decofile snapshot (starts as `{}` for a fresh app; Studio
  fills it as content is authored).
- `generate.digests.json` — the incremental-generation cache (commit it).

The React-runtime artifacts (`sections.gen.ts`, `blocksManifest.gen.ts`,
`loaders.gen.ts`, `invoke.gen.ts`) are intentionally **not** produced — Eitri
doesn't use them.

## Programmatic API

```ts
import { generateEitri } from "@decocms/eitri";

const code = await generateEitri({ root: "path/to/app", force: true });
```

## Flags

`deco-eitri generate` forwards every `@decocms/blocks-cli` `generate` flag
(`--root`, `--force`, `--dry-run`, `--sections-dir`, `--namespace`, `--site`,
…). Run `npx deco-eitri generate --help` for the full list. `--platform eitri`
is always applied.
