# deco-start

Framework layer for [deco.cx](https://deco.cx) storefronts — a Bun workspace monorepo of five packages, split out of the single `@decocms/start` package to give each concern real package boundaries instead of bundled dist tiers.

None of these packages are published yet (all sit at `0.0.0`). Consuming sites link against a local checkout via `bun link` until the first release — see [Local development](#local-development) below.

---

## What's in the box

```
┌──────────────────────────────────────────────────────────┐
│   Site repo (your storefront)                             │  ← Components, sections, routes
├──────────────────────────────────────────────────────────┤
│   @decocms/apps  (commerce integrations)                  │  ← VTEX, Shopify, Magento, ...
├──────────────────┬───────────────────┬────────────────────┤
│  @decocms/tanstack │  @decocms/next    │  (future bindings) │  ← Framework bindings
├──────────────────┴───────────────────┴────────────────────┤
│   @decocms/admin        (admin protocol, site bootstrap)   │
├──────────────────────────────────────────────────────────┤
│   @decocms/runtime       (CMS core — zero framework deps)  │
└──────────────────────────────────────────────────────────┘
                    ↑ codegen: @decocms/cli
```

| Package | Responsibility | Depends on |
|---|---|---|
| **`@decocms/runtime`** | Framework-agnostic CMS core: block loading, page/section resolution, the section registry, matchers, request context. Zero deco-package dependencies. | — |
| **`@decocms/admin`** | Admin protocol (`/live/_meta`, `/.decofile`, `/deco/render`, `/deco/invoke`) and the admin half of site setup (`createAdminSetup`: meta schema, preview shell, commerce-loader wiring). | `runtime` |
| **`@decocms/cli`** | Codegen (`generate-blocks`, `generate-schema`, `generate-invoke`, `generate-sections`, `generate-loaders`) and the Fresh/Preact/Deno → TanStack migration scripts. | `runtime` |
| **`@decocms/tanstack`** | Production TanStack Start + Cloudflare Workers binding: `cmsRouteConfig`, `DecoPageRenderer`, `createDecoWorkerEntry`, the Vite plugin, fast-deploy (KV-backed content). | `runtime`, `admin`, `cli` |
| **`@decocms/next`** | Next.js App Router binding: `createDecoPage`, `DecoRootLayout`, `SectionRenderer`/`ClientOnlySection`/`DeferredSectionBoundary`, and admin Route Handlers. RSC-native — no Vite, no Cloudflare-specific code. | `runtime`, `admin` |

Every export maps straight to a `.ts` source file — no package bundles another's source, which is the actual fix for the module-state-duplication bug that caused the v5.2.2 revert of the old single-package, tsup-bundled `@decocms/start`.

Working examples of both bindings: [`examples/tanstack-smoke`](./examples/tanstack-smoke) and [`examples/next-smoke`](./examples/next-smoke).

---

## Hello, World (TanStack Start)

### `package.json`

```jsonc
{
  "name": "my-store",
  "type": "module",
  "scripts": { "dev": "vite dev", "build": "vite build", "deploy": "wrangler deploy" },
  "dependencies": {
    "@decocms/runtime": "*",
    "@decocms/admin": "*",
    "@decocms/tanstack": "*",
    "@decocms/apps": "^1.11.0",
    "@tanstack/react-start": "^1.166.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": { "vite": "^6.0.0", "wrangler": "^4.72.0" }
}
```

### `vite.config.ts`

```ts
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error — @decocms/tanstack/vite ships plain .js, no .d.ts yet
import { decoVitePlugin } from "@decocms/tanstack/vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({ server: { entry: "server" } }),
    react({ babel: { plugins: ["babel-plugin-react-compiler"] } }),
    decoVitePlugin(),
  ],
  resolve: {
    alias: { "~": "/src" },
    dedupe: ["react", "react-dom", "@decocms/runtime", "@decocms/admin", "@decocms/tanstack", "@decocms/apps"],
  },
});
```

### `src/setup.ts`

```ts
import { createSiteSetup } from "@decocms/runtime/setup";
import { createAdminSetup } from "@decocms/admin/setup";
import { applySectionConventions } from "@decocms/runtime/cms";
import { setupTanstackFastDeploy } from "@decocms/tanstack";

import blocks from "./server/cms/blocks.gen";
import sectionsGen from "./server/cms/sections.gen";
import meta from "./server/cms/meta.gen.json";

createSiteSetup({
  sections: import.meta.glob("./sections/**/*.tsx", { eager: true }),
  blocks,
  productionOrigins: ["https://my-store.com"],
});

createAdminSetup({ meta: () => meta });
applySectionConventions(sectionsGen);
setupTanstackFastDeploy();
```

### `src/worker-entry.ts`

```ts
import "./setup"; // MUST be first

import { createDecoWorkerEntry } from "@decocms/tanstack";
import { handleMeta, handleDecofileRead, handleDecofileReload, handleRender, handleInvoke } from "@decocms/admin";
import serverEntry from "./server";

export default createDecoWorkerEntry(serverEntry, {
  admin: { handleMeta, handleDecofileRead, handleDecofileReload, handleRender, handleInvoke },
});
```

### `src/routes/$.tsx`

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { cmsRouteConfig } from "@decocms/tanstack";

export const Route = createFileRoute("/$")(cmsRouteConfig({ siteName: "my-store" }));
```

`npm install`, `npm run dev`, point `admin.deco.cx` at it, and you have a working CMS-driven site. For commerce integrations (VTEX, Shopify) see [`@decocms/apps`](https://www.npmjs.com/package/@decocms/apps).

---

## Hello, World (Next.js App Router)

### `src/setup.ts`

```ts
import { createSiteSetup } from "@decocms/runtime/setup";
import { createAdminSetup } from "@decocms/admin/setup";

createSiteSetup({
  sections: { "site/sections/Hero.tsx": () => import("./sections/Hero") },
  blocks: {},
});

createAdminSetup({ meta: () => Promise.resolve({}) });
```

### `src/app/layout.tsx`

```tsx
import { DecoRootLayout } from "@decocms/next";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DecoRootLayout siteName="my-store">{children}</DecoRootLayout>
      </body>
    </html>
  );
}
```

### `src/app/[[...slug]]/page.tsx`

```ts
import { createDecoPage } from "@decocms/next";

export const { generateMetadata, default: Page } = createDecoPage({ siteName: "my-store" });
```

### `src/app/deco/render/route.ts`, `.decofile/route.ts`, `live/meta/route.ts`

```ts
export { renderGET as GET, renderPOST as POST } from "@decocms/next";
```

Swap `renderGET`/`renderPOST` for `decofileGET`/`decofilePOST` or `metaGET` as appropriate — see [`examples/next-smoke`](./examples/next-smoke) for the full route wiring, including the Next.js routing quirks (dot-prefixed segments stay literal, `_`-prefixed segments need `%5F`).

---

## Migrating

- **Fresh/Preact/Deno → TanStack Start**: `.agents/skills/deco-to-tanstack-migration/` (also runnable directly via `.agents/skills/deco-migrate-script/`, the automated 8-phase script).
- **Old single-package `@decocms/start@5.x` → the split packages, for Next.js sites**: `.agents/skills/deco-next-package-migration/` — covers the import remap, splitting `createSiteSetup` into `createSiteSetup` + `createAdminSetup`, and rewriting admin routes as thin per-concern Route Handlers.

These are Agent Skills — usable from Claude Code, Cursor, Codex, or any tool that supports the skill format.

---

## Peer dependencies

| Package | Peer deps |
|---|---|
| `@decocms/runtime`, `@decocms/admin` | `react ^19.0.0`, `react-dom ^19.0.0` |
| `@decocms/tanstack` | + `@tanstack/react-start >=1.0.0`, `@tanstack/store >=0.7.0`, `@tanstack/react-query >=5.0.0`, `vite >=6.0.0` |
| `@decocms/next` | + `next >=15.0.0` |

OpenTelemetry is optional but recommended: `@microlabs/otel-cf-workers >=1.0.0-rc.0`, `@opentelemetry/api >=1.9.0`.

---

## Local development

```bash
bun install
bun run typecheck   # per-package tsc --noEmit
bun run test        # per-package vitest
bun run check       # typecheck + lint + unused-exports
```

This is a monorepo of libraries — there's no dev server here. `examples/tanstack-smoke` and `examples/next-smoke` are minimal real consumers you can `bun run dev` directly.

**Linking into a real site** (until packages are published):

```bash
cd packages/runtime && bun link
cd packages/admin && bun link
cd packages/tanstack && bun link   # or packages/next
```

Then in the site repo: `bun link @decocms/runtime @decocms/admin @decocms/tanstack && bun install`. Full walkthrough in the `deco-next-package-migration` skill.

Contributing? See [`CLAUDE.md`](./CLAUDE.md) for architectural decisions, [`MIGRATION_TOOLING_PLAN.md`](./MIGRATION_TOOLING_PLAN.md) for the append-only history of the migration tooling, and the `docs/` folder for fast-deploy, observability, and RUM guides.

---

## License

Not yet declared — no `LICENSE` file or `license` field exists in this repo at present.
