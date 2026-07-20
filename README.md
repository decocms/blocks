<p align="center">
  <a href="https://www.decocms.com">
    <img src=".github/assets/deco-logo.svg" width="240" alt="Deco" />
  </a>
</p>

<h1 align="center">blocks</h1>

<p align="center">
  The framework and integration layer behind Deco CMS storefronts.
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
  <img alt="TanStack Start" src="https://img.shields.io/badge/TanStack-Start-FF4154?style=flat-square" />
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-App_Router-000000?style=flat-square&logo=next.js&logoColor=white" />
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflareworkers&logoColor=white" />
</p>

`blocks` is a Bun workspace monorepo containing Deco's framework-agnostic CMS runtime, Studio admin protocol, code generators, framework bindings, and portable commerce integrations. Packages are published together under the `@decocms/*` scope and export TypeScript source directly—there is no bundled dist layer or duplicated runtime state.

## Contents

- [Why blocks](#why-blocks)
- [Architecture](#architecture)
- [Packages](#packages)
- [Getting started](#getting-started)
- [Migration](#migration)
- [Development](#development)
- [Contributing](#contributing)
- [Contributors](#contributors)
- [Documentation](#documentation)
- [License](#license)

## Why blocks

- **One CMS runtime:** resolve pages, sections, flags, matchers, loaders, and request-scoped state without tying the core to a web framework.
- **Native framework bindings:** render through TanStack Start on Cloudflare Workers, Next.js App Router/RSC, or generate native authoring artifacts for Eitri.
- **Studio-ready:** expose metadata, content snapshots, invokes, and live previews through the Deco admin protocol.
- **Portable integrations:** share commerce types and connect VTEX, Shopify, Magento, Salesforce Commerce Cloud, Algolia, Resend, blog, SEO, analytics, and theme capabilities.
- **Migration tooling included:** move Fresh/Preact storefronts to TanStack Start or upgrade older `@decocms/start` sites to the split packages.

## Architecture

The dependency graph is intentionally one-way. Framework packages compose the lower layers; the runtime never imports a framework binding.

```text
                  Storefront or native app
                           │
          ┌────────────────┼─────────────────┐
          │                │                 │
 @decocms/tanstack  @decocms/nextjs  @decocms/eitri
          │                │                 │
          ├──────┬─────────┘                 │
          │      │                           │
 @decocms/blocks-admin              @decocms/blocks-cli
          │      │                           │
          └──────┴──────────┬────────────────┘
                            │
                    @decocms/blocks
                            ▲
                            │
                    @decocms/apps-*
```

The split fixes the module-state duplication that occurred when the former `@decocms/start` package bundled multiple copies of shared singletons. Every public export now resolves to its owning package's source.

### Repository layout

```text
packages/
├── blocks/          CMS runtime and portable SDK
├── blocks-admin/    Studio protocol and admin setup
├── blocks-cli/      Code generation, audits, and migrations
├── tanstack/        TanStack Start + Cloudflare Workers binding
├── nextjs/          Next.js App Router binding
├── eitri/           Eitri schema and decofile generator
└── apps-*/          Shared capabilities and platform integrations
examples/
├── tanstack-smoke/  Minimal TanStack consumer
└── nextjs-smoke/    Minimal Next.js consumer
docs/                Architecture, operations, troubleshooting, and guides
.agents/skills/      Agent-assisted migration playbooks
```

## Packages

All packages are versioned and released in lockstep.

### Runtime and tooling

| Package | Purpose |
| --- | --- |
| [`@decocms/blocks`](./packages/blocks) | Framework-agnostic CMS resolution, section registry, flags, matchers, middleware, hooks, and SDK utilities. |
| [`@decocms/blocks-admin`](./packages/blocks-admin) | Studio protocol handlers for metadata, decofile content, invokes, previews, and admin setup. |
| [`@decocms/blocks-cli`](./packages/blocks-cli) | Incremental code generation, validation, observability tooling, and storefront migration CLIs. |

### Framework bindings

| Package | Target | Highlights |
| --- | --- | --- |
| [`@decocms/tanstack`](./packages/tanstack) | TanStack Start + Cloudflare Workers | CMS routes, worker entry, Vite plugin, deferred sections, and KV-backed fast deploy. |
| [`@decocms/nextjs`](./packages/nextjs) | Next.js 15+ App Router | RSC-native pages and previews, route handlers, root layout, and one-call setup. |
| [`@decocms/eitri`](./packages/eitri) | Eitri mobile stack | Generates self-contained Studio schema and decofile artifacts; rendering remains native. |

### Apps and integrations

| Package | Integration |
| --- | --- |
| [`@decocms/apps-commerce`](./packages/apps-commerce) | Shared commerce types, registry, SDK, and portable utilities. |
| [`@decocms/apps-website`](./packages/apps-website) | SEO, analytics, themes, fonts, and generic website capabilities. |
| [`@decocms/apps-vtex`](./packages/apps-vtex) | VTEX Commerce. |
| [`@decocms/apps-shopify`](./packages/apps-shopify) | Shopify. |
| [`@decocms/apps-magento`](./packages/apps-magento) | Magento. |
| [`@decocms/apps-salesforce`](./packages/apps-salesforce) | Salesforce Commerce Cloud. |
| [`@decocms/apps-algolia`](./packages/apps-algolia) | Algolia search. |
| [`@decocms/apps-blog`](./packages/apps-blog) | Blog content and CMS integration. |
| [`@decocms/apps-resend`](./packages/apps-resend) | Resend transactional email. |

## Getting started

The monorepo uses [Bun](https://bun.sh/) 1.3+. The web bindings target React 19; Eitri is generation-only. Pick the binding that matches your application.

### TanStack Start

```bash
bun add @decocms/blocks @decocms/blocks-admin @decocms/tanstack \
  @tanstack/react-start @tanstack/react-query @tanstack/store react react-dom
bun add -d vite
```

Bootstrap the runtime and Studio protocol in your server setup:

```ts
import { createAdminSetup } from "@decocms/blocks-admin/setup";
import { createSiteSetup } from "@decocms/blocks/setup";
import { setupTanstackFastDeploy } from "@decocms/tanstack";

createSiteSetup({
  sections: import.meta.glob("./sections/**/*.tsx"),
  blocks: {},
});

createAdminSetup({ meta: () => Promise.resolve({}), css: "" });
setupTanstackFastDeploy();
```

Add `decoVitePlugin()` to Vite and mount `cmsRouteConfig()` in the catch-all route. See the working [`tanstack-smoke`](./examples/tanstack-smoke) application and the [fast deploy guide](./docs/fast-deploy.md) for production wiring.

### Next.js App Router

```bash
bun add @decocms/blocks @decocms/blocks-admin @decocms/nextjs
```

The Next.js binding has four required integration points:

1. wrap `next.config` with `withDeco()`;
2. create an `ensureSetup` function with `createNextSetup()`;
3. mount the Studio catch-all route and RSC preview page;
4. await setup from the root layout and render CMS pages with `createDecoPage()`.

The complete copy-ready setup is in the [`@decocms/nextjs` guide](./packages/nextjs/README.md). A minimal end-to-end implementation lives in [`nextjs-smoke`](./examples/nextjs-smoke).

### Eitri

```bash
bun add -d @decocms/eitri
bunx deco-eitri init
bunx deco-eitri generate
```

Eitri uses Deco for schema and content authoring, then renders sections natively. See the [`@decocms/eitri` guide](./packages/eitri/README.md).

## Migration

Choose the migration path based on the site's current stack:

| From | To | Guide |
| --- | --- | --- |
| Fresh / Preact / Deno | TanStack Start / React / Workers | [`deco-to-tanstack-migration`](./.agents/skills/deco-to-tanstack-migration) |
| Automated Fresh migration | TanStack Start / React / Workers | [`deco-migrate-script`](./.agents/skills/deco-migrate-script) |
| `@decocms/start@6.x` + `@decocms/apps@5.x` | Split v7 TanStack packages | [`decocms-v6-to-v7-upgrade`](./.agents/skills/decocms-v6-to-v7-upgrade) |
| `@decocms/start@5.x` Next tiers | Split Next.js packages | [`deco-next-package-migration`](./.agents/skills/deco-next-package-migration) |

These playbooks follow the Agent Skills format and can be used from Codex, Claude Code, Cursor, or another compatible agent.

## Development

Install dependencies from the repository root:

```bash
bun install
```

Common commands:

| Command | What it checks |
| --- | --- |
| `bun run build` | Builds every package with TypeScript. |
| `bun run typecheck` | Type-checks every package without emitting files. |
| `bun run test` | Runs the Vitest suite for every package. |
| `bun run lint` | Runs Biome across package sources and scripts. |
| `bun run lint:unused` | Finds unused exports with Knip. |
| `bun run audit:secrets` | Scans package sources for leaked secrets. |
| `bun run check` | Runs typecheck, lint, unused-export checks, and the secrets audit. |

This repository contains libraries rather than a root application. Run either smoke app directly when you need a development server:

```bash
cd examples/tanstack-smoke && bun run dev
# or
cd examples/nextjs-smoke && bun run dev
```

To test unpublished local changes in another site, run `bun link` inside each package you need, then link those package names from the consuming site.

## Contributing

Contributions are welcome. Before opening a pull request:

1. read [`CLAUDE.md`](./CLAUDE.md) for the package boundaries and load-bearing architectural constraints;
2. keep changes inside the package that owns the concern—especially the one-way dependency graph;
3. add or update tests for behavior changes;
4. run `bun run check` and the relevant package tests;
5. use [Conventional Commits](https://www.conventionalcommits.org/) so semantic-release can determine the next version.

For migration-tooling work, the signed-off decisions in [`MIGRATION_TOOLING_PLAN.md`](./MIGRATION_TOOLING_PLAN.md) are authoritative. For release history, see the [changelog](./CHANGELOG.md) and [GitHub releases](https://github.com/decocms/blocks/releases).

## Contributors

Thanks to everyone who has helped build and improve Deco blocks.

<a href="https://github.com/decocms/blocks/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=decocms/blocks" alt="Deco blocks contributors" />
</a>

New contributors are always welcome—start with an [open issue](https://github.com/decocms/blocks/issues) or propose a focused pull request.

## Documentation

| Topic | Guide |
| --- | --- |
| Fast deploy and KV-backed content | [`docs/fast-deploy.md`](./docs/fast-deploy.md) |
| Observability | [`docs/observability.md`](./docs/observability.md) |
| Troubleshooting | [`docs/troubleshooting.md`](./docs/troubleshooting.md) |
| Operations runbooks | [`docs/runbooks`](./docs/runbooks) |
| Deco filesystem contract | [`docs/deco-fs-contract.md`](./docs/deco-fs-contract.md) |
| Hydration and SSR migration | [`docs/hydration-and-ssr-migration.md`](./docs/hydration-and-ssr-migration.md) |
| Known gaps | [`docs/known-gaps.md`](./docs/known-gaps.md) |
| Storefront implementation skills | [`docs/skills`](./docs/skills) |

## License

This repository does not currently declare a license. Contact the maintainers before redistributing or incorporating the source outside the terms under which you received it.
