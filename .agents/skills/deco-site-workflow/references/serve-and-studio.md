# Connect a site to deco Studio (and what happened to `deco serve`)

This page takes a v8 site from "Studio can't edit it" to "editors change content in Studio, preview
it, and publish it", with nothing else to read.

## If Studio asks you to connect `deco serve`

`deco serve` served `.deco/` from your working tree to Studio over a local endpoint. It existed in
`@decocms/blocks` 8.9.x and earlier. **It was removed in 8.10.0**, when content moved to Studio's
hosted CMS on the CDN. On 8.10+:

```text
$ npx deco serve
unknown command "serve"
…
```

(exit 64). Check the installed version with `npm ls @decocms/blocks`. `npx deco --help` lists the
commands this version has.

- **On 8.10 or newer:** there is nothing to run on your machine. Studio edits hosted drafts, and the
  site reads them from the CDN. "Connecting" is Steps 1 to 5 below.
- **On 8.9.x or older:** upgrade `@decocms/blocks` (and the binding, `@decocms/tanstack` or
  `@decocms/nextjs`, at the same version), then do Steps 1 to 5. This skill doesn't document the old
  `deco serve` flags.
- Studio showing `the endpoint speaks an older deco-content than this client needs (1.1 or newer):
  update @decocms/blocks (8.2.0 or newer) where the endpoint runs` means it reached an 8.1.x
  `deco serve`. Same fix: upgrade.

## Step 1: the site reads hosted content

```ts
// src/cms.ts
import { createCMS } from "@decocms/blocks";
import blocks from "../.deco";

export const cms = createCMS({ blocks, site: process.env.DECO_SITE! });
```

- `site` is Studio's site name. `@decocms/blocks` reads no environment variable: the site passes the
  value. On Workers, put `DECO_SITE` in `wrangler.jsonc` `vars`. The CLI reads the same var (see
  [schema.md](./schema.md), Step 2).
- Leave `content` out. Passing both `site` and `content` is a `TypeError`.
- A site moving from bundled content (`createCMS({ blocks, content })` with `.deco/blocks.gen.ts`)
  drops `content`, the import of the generated module, and `deco content` from its scripts.

How the binding wires `cms` into routes and the worker is in `deco-tanstack-site` /
`deco-nextjs-site`.

## Step 2: send the schema

```bash
npx deco schema && npx deco schema push
```

Without it, Studio has no forms. Tokens, errors and CI wiring: [schema.md](./schema.md).

## Step 3: publish a first release, before you deploy with `site`

With `site` set, the site has no content until a release exists. The first request on a site whose
`latest.json` is missing (never published) fails with `LOADER_FAILED` (cause
`ContentUnavailableError`); the SDK never serves an empty site. So publish first:

```bash
# .deco/blocks holds the content you have (bundled before, or written by hand)
npx deco push --draft=initial        # every file is new: all of them go to the draft
npx deco check --draft=initial       # the draft against the code
npx deco publish --draft=initial     # the first release
```

Then remove `.deco/blocks/` from git and add `.deco/blocks/` and `.deco/pull.json` to `.gitignore`.
`deco pull` fills the folder again when you need it. A push must fit one save (500 blocks, 8 MiB,
1 MiB per block); for a bigger site see [content-sync.md](./content-sync.md#push).

A site with no content yet can skip this only if it creates its first blocks in Studio and publishes
before the deploy that sets `site`.

## Step 4: the page accepts Studio's frame

Studio opens the site in an iframe and loads its editor code into the page through the **Studio
channel**, a small inline script the bindings put on every page:

- **TanStack** (`@decocms/tanstack`): `DecoDocument` in `__root.tsx` (or `<DecoPreview site=… />` in
  a document of your own) mounts the bridge, the channel and the draft badge. `createDecoWorker` adds
  Studio's origins to `frame-ancestors` and `script-src` and sends no `X-Frame-Options`.
- **Next.js** (`@decocms/nextjs`): `<StudioBridge site="my-store" />` in the root layout's `<body>`.
  A site that writes its own CSP passes it through `withStudioCsp(directives)`. Render
  `<StudioPage pathTemplate={match.entry.path} />` on CMS pages so Studio opens the right page.

The page trusts an exact list of Studio origins: the binding's `studioOrigins` option, else the
`DECO_STUDIO_ORIGIN` env var (comma-separated), else `https://studio.decocms.com` and
`https://studio-stg.decocms.com`. A page framed by any other origin does nothing. For a Studio you
run locally, set `DECO_STUDIO_ORIGIN=http://localhost:3000` (its origin) for the site, and
`DECO_STUDIO_URL` to its API base for the CLI.

## Step 5: previews, in Studio and on your machine

Studio saves edits into a draft. A draft is seen through a link: `?__draft=<pointer>` on any page.
The CLI prints it:

```bash
npx deco drafts url my-change
# a preview URL, or a pointer plus:
# (the site has no preview address in Studio: open the site with ?__draft=<this pointer>)
```

A draft link previews only on allowed hosts: the ones Studio writes into the release
(`previewHosts` in `latest.json`) plus `createCMS({ preview: { hosts } })`. On any other host the link
silently renders the published release. That is the usual reason a draft "shows production" on
`localhost`. Allow it in dev:

```ts
createCMS({
  blocks,
  site: process.env.DECO_SITE!,
  // Vite dev; on Next.js test process.env.NODE_ENV === "development"
  ...(import.meta.env.DEV ? { preview: { hosts: ["localhost"] } } : {}),
});
```

A host pattern without a port matches any port. Before the first publish, or for a release published
before Studio wrote `previewHosts`, every host previews.

Local dev reads content from the CDN like production. Editing `.deco/blocks` locally changes nothing
on the page until you `deco push` it to a draft and open the draft link.

## Diagnose a site Studio can't edit

| Symptom | Check | Fix |
|---|---|---|
| Studio says to send the schema, or forms are empty or stale | `npx deco schema push` prints `(a v8 schema)` | [schema.md](./schema.md) |
| Page in Studio is blank or refuses to frame | `curl -sI <url>`: `content-security-policy` has `frame-ancestors` with `https://studio.decocms.com`; no `x-frame-options` | Use the binding's worker or `withStudioCsp`; remove your own `X-Frame-Options` |
| Page shows, but no section outlines or live updates | Page HTML has a `<script data-deco-studio-channel …>`; its `data-studio-origins` lists Studio's origin | Mount `DecoDocument` / `DecoPreview` / `StudioBridge`; fix `studioOrigins` or `DECO_STUDIO_ORIGIN`; add the CSP `nonce` |
| Every page errors with `LOADER_FAILED` | `https://delivery.decocms.com/sites/<site>/latest.json` returns 404 | Publish a first release (Step 3) |
| Draft link shows the published content | Host not in the preview hosts | `preview.hosts` (Step 5) |
| Draft link shows the release and a notice that the draft can't be read | The draft no longer exists or can't be read | Get a fresh link with `deco drafts url <name>` |
| `/live/*`, `/.decofile`, `/deco/*` answer 404 | Expected on v8 (TanStack worker). `/deco/_liveness` answers `OK` | Remove v7 admin wiring; see `deco-v7-to-v8-migration` |
| A CLI command exits 3 | No token, or Studio refused it | [schema.md](./schema.md), Step 3 |
