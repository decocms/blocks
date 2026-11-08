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

`blocks` is a Bun workspace monorepo for Deco's CMS. This branch is the **next major (v8)**: one core package, `@decocms/blocks`, with the runtime, the `deco` CLI and the content protocol the site editor speaks; `@decocms/tanstack`, for TanStack Start sites on Cloudflare Workers; `@decocms/nextjs`, for any Next.js App Router app; thin upstream clients, `@decocms/apps-*`; and `@decocms/compat-v7`, v7's pure helpers for sites moved from v7. Each package publishes JavaScript compiled file for file by `tsc` (`dist/`, with declarations), plus its TypeScript source under a `source` export condition for the workspace: nothing is bundled, so no runtime state is duplicated.

v7 (`@decocms/tanstack` 7.x, `@decocms/nextjs` 7.x, `@decocms/blocks-admin`, `@decocms/blocks-cli`, `@decocms/apps-commerce` and the rest) is maintained on the [`7.x` branch](https://github.com/decocms/blocks/tree/7.x).

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
- **Any framework:** TanStack Start, Next.js App Router or plain Node; the core package has no framework binding (`@decocms/tanstack` and `@decocms/nextjs` are separate) and runs on Workers, Node and Bun.
- **Site-editor ready:** the content protocol (`@decocms/blocks/protocol`) lets the site editor read and write saved blocks without running your code.
- **Measured upstream calls:** every client sends through `createInstrumentedFetch`, so each upstream request is timed and labeled.

## Packages

All packages are versioned and released in lockstep, starting at 8.4.0 for the bindings and `@decocms/compat-v7`. The bindings, `@decocms/compat-v7` and the clients take `@decocms/blocks` as a peer dependency (`^8.6.0` for the bindings, `^8.4.0` for the others), so a site installs one copy of it.

| Package | Purpose |
| --- | --- |
| [`@decocms/blocks`](./packages/blocks) | Runtime (`createCMS`, `matchRoute`, loaders, built-in blocks), the `deco` CLI (`/cli`), the content protocol (`/protocol/*`), `createInstrumentedFetch` (`/fetch`), analytics (`/analytics`) and the `vite dev` content reload plugin (`/vite`). |
| [`@decocms/tanstack`](./packages/tanstack) | TanStack Start on Cloudflare Workers, deployed the Deco way: the edge worker (`/worker`), the root document (`/react`), the router (`/router`), the server-function fetch (`/start`), server helpers (`/server`) and the Vite plugin (`/vite`). |
| [`@decocms/nextjs`](./packages/nextjs) | Any Next.js App Router app: draft previews in the proxy (`/proxy`) and the pages (`/server`), the preview badge and the Studio bridge (root), `withDeco()` for `next.config` (`/config`) and a next/image loader (`/image-loader`). |
| [`@decocms/compat-v7`](./packages/compat-v7) | v7's pure helpers with v7's output, for sites moved from v7: section types and widget aliases (`/types`), device detection (`/device`), inline scripts (`/script`), `clx` (`/clx`), v7's matchers, with the sticky random (`/matchers`), v7's section loader runner with its mixins (`/sections`), `@decocms/apps-commerce`'s types and helpers (`/commerce/*`), and v7's device context and A/B cookie for each binding (`/tanstack`, `/nextjs`). No v7 runtime. |
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
├── tanstack/        @decocms/tanstack: TanStack Start on Cloudflare Workers
├── nextjs/          @decocms/nextjs: any Next.js App Router app
├── compat-v7/       @decocms/compat-v7: v7's pure helpers for migrated sites
└── apps-*/          thin upstream clients
tests/               cross-package tests (upstream-client guardrail and conformance)
examples/
├── tanstack-smoke/      TanStack Start on Workers (the descriptor guide)
├── tanstack-rsc-smoke/  TanStack Start with React Server Components
├── nextjs-smoke/        Next.js App Router (the docs' guide)
└── nextjs-binding-smoke/ Next.js App Router on @decocms/nextjs (drafts, Studio, image loader)
.agents/skills/      agent skills: the v7 -> v8 migration (index: .agents/skills/README.md)
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

Name the Studio site, and read content through the CMS. Content isn't bundled: the client fetches the latest release from the CDN at runtime.

```ts
import { createCMS } from "@decocms/blocks";
import blocks from "./.deco";

export const cms = createCMS({ blocks, site: process.env.DECO_SITE! });

const [props, error] = await cms.forRelease().resolve("Home Hero");
```

A client reads one block at a time. What a site needs about all of them comes from the release's index, with no block fetched: `routes()` and `redirects()` for routing, and `entries(type?)` for the rest (`{ name, type, path?, refs, noIndex? }` per saved block; a sitemap is the `page` entries' paths without `:param` or `*` segments and without `noIndex`). There is no `list()` (removed in 8.11): it fetched every block of a type.

```ts
const [pages] = await cms.forRelease().entries("page");
const sitemap = pages!
  .filter((p) => p.path && !p.noIndex && !/(^|\/)(:|\*)/.test(p.path))
  .map((p) => p.path!);
```

On production deploys, CI runs `deco schema && deco schema push` so Studio draws forms from the deployed code; a team that wants the guard adds `deco check`, which checks production (the live release, from the CDN) against the code. The `deco` CLI also edits content remotely, through the Studio API (log in once with `npx decocms auth login`, or set `DECO_TOKEN` to a Studio API key). It talks to the site named by `DECO_SITE`: the environment's, else the first of `.env`, `.dev.vars`, then `vars.DECO_SITE` in `wrangler.jsonc`, `wrangler.json` or `wrangler.toml`, in the folder that contains `.deco/`; Studio knows the site's organization.

```bash
deco pull                         # production into .deco/blocks (git-ignored); or --draft=<name>
deco check && deco diff
deco push --draft=pdp-copy        # exit 2 on a conflict; --ours / --theirs
deco publish --draft=pdp-copy     # makes the draft live
```

`deco drafts`, `deco releases` and `deco check --draft=<name> | --revision=<id>` cover the rest; every command takes `--json`. `deco skills install` copies the agent skills of the installed `@decocms/blocks` into the site's `.claude/skills` (or `--dir`), so coding agents load the skills of the version the site runs; it needs no network. Exit codes: 0 ok, 1 failed, 2 conflict, 3 auth, 4 network, 5 busy (run again), 64 usage.

### TanStack Start

Follow the docs' TanStack Start guide (`/next/tanstack-start-descriptors`, or `/next/tanstack-start-rsc` for React Server Components): `createCMS({ blocks, site })`, so content arrives from the CDN at runtime, `matchRoute` in a catch-all route, one promise per block. [`examples/tanstack-smoke`](./examples/tanstack-smoke) and [`examples/tanstack-rsc-smoke`](./examples/tanstack-rsc-smoke) are complete apps; they have no Studio site, so they pass `content`, a module written by `content()` from `@decocms/blocks/cli`, and add `decoContent()` from `@decocms/blocks/vite` in `vite.config.ts` so an edit of that module shows in open pages during `vite dev`. A site on Cloudflare Workers deployed the Deco way uses [`@decocms/tanstack`](./packages/tanstack): `createDecoWorker` (drafts, Studio framing, the hook for the site's own page cache, with a complete recipe), `DecoDocument`, the router, `Image`/`Picture` and `decoTanstack()` (which includes `decoContent()`); [`examples/tanstack-worker-smoke`](./examples/tanstack-worker-smoke) is the same app on it.

### Next.js App Router

Follow the docs' Next.js guide (`/next/nextjs`). [`examples/nextjs-smoke`](./examples/nextjs-smoke) is a complete app: a Server Component resolves the page and renders its blocks. [`@decocms/nextjs`](./packages/nextjs) adds draft previews (the proxy, the draft route, the badge), the Studio bridge, `withDeco()` and a next/image loader; [`examples/nextjs-binding-smoke`](./examples/nextjs-binding-smoke) is the same app on it.

### Studio inside the page

Both bindings mount the Studio channel on every page, production included (`StudioChannel` from `@decocms/blocks/preview`, about 0.7 kB of inline script gzipped): when Studio frames the page, it loads Studio's own editor code (the section wireframe, the page swap after a save) from Studio's origin; when the page isn't framed, or is framed by any other origin, it does nothing. It is the only way Studio runs code in the page: the bridge evaluates no script Studio sends. The page trusts a list of exact Studio origins: the binding's `studioOrigins` option, else `DECO_STUDIO_ORIGIN` (comma-separated; a local Studio), else Studio's production and staging origins (`https://studio.decocms.com`, `https://studio-stg.decocms.com`). It accepts a module only from a message whose origin is exactly one of them and only at a URL on the origin of that message, and posts `deco:ready` with each trusted origin as the target, so only a parent at one of them receives it. The binding adds the same list to the page's Content Security Policy: `frame-ancestors`, and `script-src` when the site's policy restricts scripts (the TanStack worker does it for its `csp`; a Next.js site passes its own policy through `withStudioCsp`). The inline scripts take the site's `nonce`. The messages and the module contract are typed in `@decocms/blocks/protocol` (`StudioChannelContext`, `defineStudioModule`).

## Migration

Moving a v7 site (`@decocms/blocks` 7.x with `@decocms/tanstack` or `@decocms/nextjs`) to v8 is the [`deco-v7-to-v8-migration`](./.agents/skills/deco-v7-to-v8-migration) agent skill. Point your coding agent at it, or run its script yourself from a checkout of this branch:

```bash
bun .agents/skills/deco-v7-to-v8-migration/scripts/main.ts --root <site>
```

It writes the block map with your v7 type names as aliases, vendors the app loaders your content calls, moves content to `.deco/blocks`, lists v7 secrets to move to your deploy platform's secrets and reports every v7 import with its replacement. See the skill's `SKILL.md` and the docs page "Migrating from v7" (`/next/renames-and-migrations`).

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
| `bun run skills:check` | Checks the agent skills: frontmatter, size budgets, dead links. `bun run skills:readme` regenerates their index; `skills:readme:check` fails when it's stale. |

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
