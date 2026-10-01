# Deco Blocks docs site

The source of the Deco Blocks documentation site: **Home** (`/`), the **Docs** and **Under the
hood** pages of each docs version (`/next/…` for the next major, `/v7/…` for the current
release), and the **Roadmap** (`/roadmap/…`, the to-do list that gets the next major to a
release), plus ⌘K search, a light/dark theme toggle and a printable layout.

It's a static site: **TanStack Start** (React 19, TanStack Router, Vite) prerenders every page to
HTML, **MDX** holds the content, **Shiki** highlights code at build time, **Tailwind CSS v4**
carries the design tokens and **Pagefind** builds the search index. How it fits together, and the
conventions for pages and components, are in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Build and preview

`site/` is a standalone Bun package (its own `package.json` and `bun.lock`, not a workspace of
the monorepo). It needs Bun 1.3.5 and Node 22.12 or newer: Bun installs and runs the scripts,
and `vite build` runs under Node. From `site/`:

```sh
bun install
bun run dev       # dev server on http://localhost:3000
bun run check     # tsc, content checks, Roadmap data checks
bun run build     # prerender into dist/client/, 404.html, link check, search index
bun run preview   # serve dist/client/ the way GitHub Pages does, on http://localhost:4173
```

- `BASE_PATH=/blocks/` builds for a sub-path (GitHub Pages serves this repository at `/blocks/`);
  the default is `/`. Use the same value for `build` and `preview`.
- `DOCS_LINKS=warn` reports broken internal links without failing the build.
- The output to deploy is `dist/client/` (`dist/` is gitignored). Search only works on a build,
  not in `dev`. Open the build through `bun run preview`, not from disk: asset URLs are
  root-relative.

CI (`.github/workflows/pages.yml`) checks and builds the site on every pull request that touches
`site/` and uploads `dist/client/` as the `docs-site` workflow artifact (built for `/`; serve it
with any static server that maps `/x` to `x.html`). Pushes to `main` that touch `site/`, and
manual runs of the workflow on `main`, build it for `/blocks/` and deploy it to GitHub Pages once
Pages is enabled with "GitHub Actions" as its source (Settings › Pages); until then the deploy job
fails and nothing else depends on it.

## Layout

| Path | What it is |
|---|---|
| `content/<version>/*.mdx` | The doc pages, one folder per docs version. A file is served at `/<version>/<file name>`; frontmatter sets its title, sidebar group and order. |
| `data/roadmap.json` | Everything the Roadmap shows. See below. |
| `components/home/` | The Home page. |
| `components/roadmap/` | The Roadmap pages, rendered from `data/roadmap.json`. |
| `components/mdx/` | Components MDX pages can use (callouts, flows, code blocks, …); API in its `README.md`. |
| `components/widgets/`, `components/search/` | The interactive widgets used in MDX (the resolution walkthrough) and the ⌘K search dialog. |
| `src/` | The app: routes, layout (header, sidebar, "on this page" rail, pager), styles and tokens. |
| `build/` | Build-time plugins: the content manifest, heading ids and outline, code highlighting. |
| `scripts/` | `check-content.ts`, `check-roadmap.ts`, `postbuild.ts` (404 page, link check, search index), `preview.ts`. |
| `assets/brand/*.svg`, `assets/cobogo-defs.svg`, `public/favicon.svg` | Logo, symbol, favicon and background patterns. The logo, symbol and favicon are deco's brand files, the same as in the public [decocms/studio](https://github.com/decocms/studio) repository; the cobogó patterns are the ones on [decocms.com](https://decocms.com). |

The only external requests the site makes are the Fontshare and Google Fonts stylesheets and the
font files they load. Keep it that way: no analytics, no third-party scripts, no remote images.

## What can go here

This directory is public twice over: the repository is public, and the site is published on
GitHub Pages. Commit only what's fine for anyone to read: no credentials or tokens, no private
repository names, paths or code excerpts, no customer or client names, no local paths, and nothing
copied from internal reports that hasn't been rewritten for a public audience. A private site is
named by its platform ("the FastStore storefront"), with no detail that identifies its codebase or
owner. Security weaknesses in code that is deployed or released today are reported privately,
never described here; the Roadmap keeps only the design requirement for the unreleased API. When
in doubt, describe the problem in terms of the framework, not of a particular private site.

## Editing the Roadmap

`data/roadmap.json` holds the Roadmap's content; `components/roadmap/` holds its structure and
the framing sentences around the data (`model.ts` checks and derives, `SectionViews.tsx` renders,
`RoadmapPage.tsx` puts a section in the docs shell, `sections.ts` maps sections and ids to URLs,
`roadmap.css` styles it). Run `bun scripts/check-roadmap.ts` (part of `bun run check` and
`bun run build`) after an edit: it fails with a message naming the item when an id, link or count
doesn't hold together.

Each section is its own page: `/roadmap/` (the overview), then `/roadmap/<section id without
"roadmap-">` (`/roadmap/blockers`, `/roadmap/api`, …). Every other id is a fragment of its
section's page (`/roadmap/api#roadmap-api--add-a-request-scope`; feature rows
`/roadmap/features#roadmap-f-<id>`). From the docs, `[x](/roadmap#<id>)` is enough: the link is
resolved to the right page, and the check fails if the id doesn't exist.

Top-level keys:

- `statuses` — the five feature statuses in rank order (`to-build`, `to-finish`, `site-code`,
  `done`, `goes-away`) with their label, the words used in counts (`word`, and `word_one` for a
  count of one), the overview tile's definition and the legend's definition.
- `sections` — the twelve sections in page order: `id`, sidebar name (`nav`), `eyebrow`, `title`.
- `overview` — the overview's `intro`, `readiness_lead` and its callouts: `fix_docs`, and an
  optional `fix_now` (a live bug to fix whether or not a site migrates). The intro and readiness
  line are checked against the data: the intro must link each site's section by its `name`, and
  the counts the readiness line states must match the features' statuses.
- `blockers` — the ten release blockers, ranked: `today`, `plan`, `features`, and
  `delivered_by` (work-item ids; each work item links back with "Part of blocker"), plus an
  optional `delivered_note` (inline HTML shown after the Delivered-by links).
- `studio_new`, `studio_legacy` — Studio support items: `today`, `features`, `delivered_by`
  (work-item or site-step ids; each must share at least one feature with the item).
- `work_items` — `group` (`api`, `cli`, `studio`, `docs`), `plan`, `features`, `docs` (ids of doc
  sections the item concerns) and `pinned` (only the two docs items that correct wrong statements;
  they come first). Within a group the page sorts by feature count; ties keep the file's order.
- `sites` — the three sites in page order, each with an `id` (what features' `sites` list), the
  `name` the page shows, a `short` name (row tags and the site filter), `section`, `description`,
  `headline` and its `steps` in execution order (`kind`: `now`, `pre`, `blocker`, `work`,
  `content` or `fix`; `no_action: true` draws a note without a box).
- `categories` — the feature categories in page order: `id`, `title`, `description`.
- `features` — keyed by feature id: `name`, `category`, `status`, `effort` (`L`, `M`, `S`),
  `sites`, `summary`, `docs` (at least one doc-section id), and the row's tags: `confidence`
  (`high` or `medium`), `first_rated` and `rated_before_review` (a status id or `null`) and
  `unconfirmed_sub_claim`.

Conventions:

- Every to-do has an explicit `id`, which is its anchor: `<section id>--<slug>` (for example
  `roadmap-api--add-a-request-scope`). Keep ids stable when a title changes, since links point at
  them; references (`delivered_by`, `{{item:…}}`) use ids.
- Titles, `today`, `plan`, `text`, `headline`, `description` and the `overview` strings are HTML.
  Titles allow only text, entities and `<code>`; work-item `plan`s are block HTML (`<p>`, `<ul>`),
  the other fields inline HTML.
- `{{item:ID}}` inside any HTML field becomes a link to that to-do, named by its current title.
- Feature `name`s and category `description`s are plain text. Feature `summary`s are plain text
  with two bits of markup: `` `code` `` and `[label](#section-id)` links.
- Don't store totals: every count on the page (per status, per site, per section, open effort,
  the "How this list was made" numbers) is computed from the items.
- Links in HTML fields keep the old single page's form, `href="#id"`, and are rewritten when the
  page renders: `#roadmap-…` to the Roadmap page holding that id, anything else to the next
  major's docs (`#studio` → `/next/studio`, `#releases--publishing` → `/next/releases#publishing`).
  Docs ids (`docs` lists, summary links) are page file names in `content/next/`; the check fails on
  one without a page (`DOCS_LINKS=warn` only warns), and the post-build link check on a missing
  `#fragment`.
