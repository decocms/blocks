<p align="center">
  <a href="https://www.decocms.com">
    <img src=".github/assets/deco-logo.svg" width="240" alt="Deco" />
  </a>
</p>

<h1 align="center">blocks</h1>

<p align="center">
  Deco CMS: make any typed function editable, with content saved as plain JSON in your repo.
</p>

<p align="center">
  <a href="https://github.com/decocms/blocks/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/decocms/blocks?display_name=tag&sort=semver&style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@decocms/blocks"><img alt="npm" src="https://img.shields.io/npm/v/@decocms/blocks?label=%40decocms%2Fblocks&style=flat-square&color=CB3837" /></a>
  <a href="https://github.com/decocms/blocks/actions/workflows/release.yml"><img alt="Release" src="https://github.com/decocms/blocks/actions/workflows/release.yml/badge.svg" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Bun" src="https://img.shields.io/badge/Bun-1.3-000000?style=flat-square&logo=bun&logoColor=white" />
</p>

<p align="center">
  <img alt="CMS" src="https://img.shields.io/badge/CMS-runtime-07401A?style=flat-square" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white" />
  <img alt="Any framework" src="https://img.shields.io/badge/framework-any-FF4154?style=flat-square" />
</p>

`blocks` is a Bun workspace monorepo for Deco's CMS. This branch is the **next major (v8)**: one package, `@decocms/blocks`, with the runtime, the `deco` CLI and the content protocol the site editor speaks, plus thin upstream clients, `@decocms/apps-*`. Packages export TypeScript source directly: no bundled dist layer, no duplicated runtime state.

v7 (`@decocms/tanstack`, `@decocms/nextjs`, `@decocms/blocks-admin`, `@decocms/blocks-cli`, `@decocms/apps-commerce` and the rest) is maintained on the [`7.x` branch](https://github.com/decocms/blocks/tree/7.x).

## Contents

- [Why blocks](#why-blocks)
- [Packages](#packages)
- [Getting started](#getting-started)
- [Migration](#migration)
- [Development](#development)
- [Contributing](#contributing)
- [Contributors](#contributors)
- [Documentation](#documentation)
- [License](#license)

## Why blocks

- **Your functions, editable:** register any function with a typed first parameter in a block map; the CLI turns its types into editor forms and checks saved content against them.
- **Content is JSON in your repo:** saved blocks live in `.deco/blocks`, read through `createCMS` with no database and no framework lock-in.
- **Any framework:** TanStack Start, Next.js App Router or plain Node; the package has no framework binding and runs on Workers, Node and Bun.
- **Site-editor ready:** the content protocol (`@decocms/blocks/protocol`) lets the site editor read and write saved blocks without running your code.
- **Measured upstream calls:** every client sends through `createInstrumentedFetch`, so each upstream request is timed and labeled.

## Packages

All packages are versioned and released in lockstep.

| Package | Purpose |
| --- | --- |
| [`@decocms/blocks`](./packages/blocks) | Runtime (`createCMS`, `matchRoute`, loaders, built-in blocks), the `deco` CLI (`/cli`), the content protocol (`/protocol/*`), `createInstrumentedFetch` (`/fetch`), analytics (`/analytics`) and secrets (`/secrets`). |
| [`@decocms/apps-vtex`](./packages/apps-vtex) | Thin VTEX client. |
| [`@decocms/apps-shopify`](./packages/apps-shopify) | Thin Shopify Storefront API client. |
| [`@decocms/apps-wake`](./packages/apps-wake) | Thin Wake Commerce client, with storefront operations on `/storefront`. |
| [`@decocms/apps-magento`](./packages/apps-magento) | Thin Magento client. |
| [`@decocms/apps-algolia`](./packages/apps-algolia) | Thin Algolia Search REST client. |
| [`@decocms/apps-resend`](./packages/apps-resend) | Thin Resend email client. |
| [`@decocms/apps-sfmc-personalization`](./packages/apps-sfmc-personalization) | Thin Salesforce Marketing Cloud Personalization (formerly Evergage) client. |

Clients depend only on `@decocms/blocks`. Converters, hooks, cart flows and caching live in your platform template, not in a package.

### Repository layout

```text
packages/
├── blocks/          @decocms/blocks: runtime, CLI and content protocol
└── apps-*/          thin upstream clients
tests/               cross-package tests (upstream-client guardrail and conformance)
examples/
├── tanstack-smoke/      TanStack Start on Workers (the descriptor guide)
├── tanstack-rsc-smoke/  TanStack Start with React Server Components
└── nextjs-smoke/        Next.js App Router
.agents/skills/      agent skills: the v7 -> v8 migration, plus v7 playbooks (7.x)
```

## Getting started

Every framework uses the same package:

```bash
bun add @decocms/blocks
```

Register your functions in a block map, `.deco/index.ts`:

```ts
import type { Blocks } from "@decocms/blocks";
import hero from "../src/sections/hero";

export default { hero } satisfies Blocks;
```

Generate the schema and the content module (`deco schema && deco content`, in `predev`/`prebuild`), then read content through the CMS:

```ts
import { createCMS } from "@decocms/blocks";
import blocks from "./.deco";
import content from "./.deco/blocks.gen";

export const cms = createCMS({ blocks, content });

const [props, error] = await cms.forRelease().resolve("Home Hero");
```

### TanStack Start

Follow the docs' TanStack Start guide (`/next/tanstack-start-descriptors`, or `/next/tanstack-start-rsc` for React Server Components): `createCMS` over the content module, `matchRoute` in a catch-all route, one promise per block. [`examples/tanstack-smoke`](./examples/tanstack-smoke) and [`examples/tanstack-rsc-smoke`](./examples/tanstack-rsc-smoke) are complete apps.

### Next.js App Router

Follow the docs' Next.js guide (`/next/nextjs`). [`examples/nextjs-smoke`](./examples/nextjs-smoke) is a complete app. There is no `@decocms/nextjs` in v8: a Server Component resolves the page and renders its blocks.

## Migration

Moving a v7 site (`@decocms/blocks` 7.x with `@decocms/tanstack` or `@decocms/nextjs`) to v8 is the [`deco-v7-to-v8-migration`](./.agents/skills/deco-v7-to-v8-migration) agent skill. Point your coding agent at it, or run its script yourself from a checkout of this branch:

```bash
DECO_CRYPTO_KEY=… bun .agents/skills/deco-v7-to-v8-migration/scripts/main.ts --root <site>
```

It writes the block map with your v7 type names as aliases, vendors the app loaders your content calls, moves content to `.deco/blocks`, re-encrypts secrets and reports every v7 import with its replacement. See the skill's `SKILL.md` and the docs page "Migrating from v7" (`/next/renames-and-migrations`).

Older migrations (Fresh to TanStack, `@decocms/start` 6.x to 7.x) target v7: use the playbooks on the [`7.x` branch](https://github.com/decocms/blocks/tree/7.x).

## Development

Install dependencies from the repository root:

```bash
bun install
```

| Command | What it checks |
| --- | --- |
| `bun run test` | Runs Vitest over the whole repo: packages, `tests/` and the migration skill's scripts. |
| `bun run typecheck` | Type-checks every package, the skill's scripts and `tests/`. |
| `bun run examples` | Builds the three examples, then type-checks them. |
| `bun run lint` | Runs Biome. |
| `bun run lint:unused` | Finds unused files, dependencies and exports with Knip. |
| `bun run check` | Runs typecheck, lint and lint:unused. |

To try unpublished changes in another site, run `bun link` in `packages/blocks` (and any client you use), then `bun link @decocms/blocks` in the site.

## Contributing

Contributions are welcome. Before opening a pull request:

1. read [`CLAUDE.md`](./CLAUDE.md) for the package boundaries and load-bearing constraints;
2. keep changes inside the package that owns the concern; clients depend only on `@decocms/blocks`;
3. add or update tests for behavior changes;
4. run `bun run check` and `bun run test`;
5. use [Conventional Commits](https://www.conventionalcommits.org/) so semantic-release can determine the next version.

For release history, see the [changelog](./CHANGELOG.md) and [GitHub releases](https://github.com/decocms/blocks/releases).

## Contributors

Thanks to everyone who has helped build and improve Deco blocks.

<a href="https://github.com/decocms/blocks/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=decocms/blocks" alt="Deco blocks contributors" />
</a>

New contributors are always welcome—start with an [open issue](https://github.com/decocms/blocks/issues) or propose a focused pull request.

## Documentation

| Topic | Guide |
| --- | --- |
| Next major (v8) | The docs site's `/next` pages: Quickstart, Blocks, Content, CLI, Upstream clients, API reference, Migrating from v7 |
| v7 operations (fast deploy, observability, runbooks) | [`docs/`](./docs) — v7 reference material; v7 itself is maintained on the [`7.x` branch](https://github.com/decocms/blocks/tree/7.x) |

## License

This repository does not currently declare a license. Contact the maintainers before redistributing or incorporating the source outside the terms under which you received it.
