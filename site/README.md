# Deco Blocks docs site

The source of the Deco Blocks documentation site: one self-contained HTML page with four
hash-routed parts — **Home**, **Docs**, **Under the hood** and **Roadmap** — plus ⌘K search, a
light/dark theme toggle and a printable layout. It documents the proposed API for the next major
version, and the Roadmap is the to-do list that gets that API to a release.

## Build and preview

```sh
python3 site/build.py && open site/dist/index.html
```

Python 3.9 or later, standard library only; no install step. The output is a single file,
`site/dist/index.html` (`dist/` is gitignored). On Linux, use `xdg-open` instead of `open`.

CI (`.github/workflows/pages.yml`) builds the page on every pull request that touches `site/`
and uploads it as the `docs-site` workflow artifact: download it from the run's summary page and
open `index.html`. Pushes to `main` that touch `site/`, and manual runs of the workflow on `main`,
deploy it to GitHub Pages once Pages is enabled with "GitHub Actions" as its source
(Settings › Pages); until then the deploy job fails and nothing else depends on it.

## Layout

| Path | What it is |
|---|---|
| `build.py` | Assembles `dist/index.html`: fills `src/shell.html`'s placeholders, inlines and compacts the CSS and JS, and renders the Roadmap. |
| `gen_roadmap.py` | Renders the Roadmap from `data/roadmap.json` and checks it (ids, links, counts). `python3 site/gen_roadmap.py` checks the data alone and prints a summary. |
| `data/roadmap.json` | Everything the Roadmap shows. See below. |
| `src/shell.html` | The page frame: header, sidebar, "on this page" rail, search dialog. |
| `src/landing.html` | The Home page. |
| `src/content.html` | The Docs and Under-the-hood pages, and the Prism syntax-highlighting bundle (MIT, license notice inside). |
| `src/style.css`, `src/dark-tokens.css`, `src/roadmap.css` | Styles. `dark-tokens.css` is spliced into `style.css`'s dark-theme blocks. |
| `src/app.js` | Routing, sidebar, search, theme, copy/print, and the Home page's interactive examples. |
| `src/brand/*.svg`, `src/cobogo-defs.svg` | Logo, symbol, favicon and background patterns. The logo, symbol and favicon are deco's brand files, the same as in the public [decocms/studio](https://github.com/decocms/studio) repository; the cobogó patterns are the ones on [decocms.com](https://decocms.com). |

The only external requests the page makes are the Fontshare and Google Fonts stylesheets and the
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

`data/roadmap.json` holds the page's content; `gen_roadmap.py` holds its structure and the
framing sentences around the data. Run `python3 site/gen_roadmap.py` after an edit: it fails with
a message naming the item when an id, link or count doesn't hold together.

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
- Links into the docs use the section ids in `src/content.html`; the build fails on a link to an
  id that doesn't exist.
