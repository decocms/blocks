# Docs site architecture

The Deco Blocks docs site is a static site built with **TanStack Start** (React 19, TanStack
Router, Vite), **Tailwind CSS v4**, **MDX** for content, **Shiki** for code highlighting and
**Pagefind** for search. `bun run build` prerenders every route to plain HTML that GitHub Pages
can serve; in the browser the same pages hydrate into a client-side app.

This folder is a standalone Bun package: its own `package.json` and `bun.lock`, not one of the
monorepo's workspaces, so the root lockfile never changes because of it.

**Prerequisites: Bun 1.3.5 and Node 22.12 or newer.** Bun installs packages and runs the scripts,
but `vite build` and its prerender run under Node (the `vite` bin is `#!/usr/bin/env node`, and
TanStack Start requires Node >= 22.12, see `engines` in `package.json`). Don't run the build with
`bun --bun vite build`: the prerender crashes under Bun's runtime. CI pins both.

## Commands

| Command | What it does |
|---|---|
| `bun install` | Install (in `site/`). |
| `bun run dev` | Dev server with HMR on http://localhost:3000 (server-rendered, like production). |
| `bun run build` | `vite build` (client + server bundles, then prerender of every page into `dist/client/`), then `scripts/postbuild.ts`: `404.html`, link check, Pagefind index. |
| `bun run preview` | Serves `dist/client/` the way GitHub Pages does (http://localhost:4173): `/x` → `x.html`, `/x/` → `x/index.html`, a directory without its slash redirects (301). |
| `bun run check` | `tsc --noEmit`, then `scripts/check-content.ts` (frontmatter, h1 = title, links between pages and to headings, no local paths), then `scripts/check-roadmap.ts` (the Roadmap data). |

Environment:

- `BASE_PATH=/blocks/` builds for a sub-path (GitHub Pages serves this repo at `/blocks/`).
  Default `/`. Used by `vite.config.ts` (Vite `base`, from which TanStack Start derives the
  router basepath) and by the post-build scripts and preview server. Use the same value for
  `build` and `preview`.
- `DOCS_LINKS=warn` makes broken links a warning instead of a build failure.
- `PORT=…` for `preview`.

**Deploy `dist/client/`.** (`dist/server/` is the SSR bundle used during the build; nothing serves
it in production.) Opening the HTML files straight from disk (`file://`) shows the content but
not the styles or scripts, since asset URLs are root-relative; use `bun run preview`.

## Layout

```
site/
├── content/                  MDX pages, one folder per docs version
│   ├── v7/*.mdx              the current release (/v7/…); index.mdx is /v7/
│   └── next/*.mdx            the next major (served at /next/<file name>; /next/ is its home)
├── components/
│   ├── mdx/                  components MDX pages use (API: components/mdx/README.md)
│   ├── ui/                   Icon/Mark (the icon set), Brand (wordmark, symbol)
│   ├── home/                 the two home pages: index.tsx default export (see "Home")
│   ├── roadmap/              the Roadmap pages, from data/roadmap.json (see "Roadmap")
│   ├── widgets/              interactive MDX widgets: named exports of index.tsx
│   └── search/               the ⌘K dialog: index.tsx default export (see "Search")
├── data/roadmap.json         the Roadmap's data
├── src/                      the app (TanStack Start's srcDirectory)
│   ├── router.tsx            createRouter: basepath, scroll restoration, hydrate hook
│   ├── routes/               file-based routes (routeTree.gen.ts is generated, and committed)
│   │   ├── __root.tsx        <html>, head (fonts, CSS, theme script), header, global UI
│   │   ├── index.tsx         /            Home (the current release, v7)
│   │   ├── roadmap/          /roadmap/    Roadmap overview (index.tsx), /roadmap/<section> ($section.tsx)
│   │   └── $version/
│   │       ├── index.tsx     /next/ (the next major's home), /v7/ (its index.mdx)
│   │       └── $slug.tsx     /next/quickstart … a doc page
│   ├── layout/               Header, Sidebar, DocsShell (+ LandingShell), Rail, DocPage, NotFound, …
│   ├── lib/                  content (manifest + page loading), nav models, chrome, theme, ui, versions
│   └── styles/               app.css (entry) → theme.css, tokens.css, base.css, prose.css, components/
├── build/                    build-time code (Node): manifest, rehype plugin, Shiki theme, slugify
├── scripts/                  check-content, check-roadmap, postbuild, preview, site-files (the URL → file lookup)
├── assets/                   brand SVGs, cobogó pattern (imported with ?raw)
├── public/                   copied as-is (favicon.svg)
└── vite.config.ts
```

## Content and the manifest

Each `content/<version>/<slug>.mdx` is one page at `/<version>/<slug>`; `index.mdx` is the
version's index (`/<version>/`). Frontmatter:

| Key | Required | Meaning |
|---|---|---|
| `title` | yes | Plain text of the page's `# h1` (`check` verifies they match). `<title>`, pager, search. |
| `group` | yes | Sidebar group. Groups appear in the order of their first page; a group's pages must be adjacent in `order`. |
| `order` | yes | Number; position in the version's reading order, unique per version and kind. |
| `nav` | no | Sidebar label (the old `data-nav`). Defaults to `title`. |
| `kind` | no | `docs` (default) or `internals`: which tab the page belongs to (Docs / Under the hood). |
| `eyebrow` | no | The small uppercase label above the h1. Defaults to `group`. |
| `description` | no | `<meta name="description">`. |

Unknown keys are an error. `build/manifest.ts` reads only the frontmatter (YAML) of every file and
builds the **manifest**: per version, the pages in reading order (all `docs` pages by `order`, then
all `internals` pages by `order`) and the sidebar groups. It's served to the app as the virtual
module `virtual:content-manifest` (invalidated in dev when content files change), and
`vite.config.ts` uses it for the list of pages to prerender.

From the manifest (`src/lib/nav.ts`):

- **Sidebar**: the groups of the current page's kind in its version.
- **Breadcrumb**: `Docs` (or `Under the hood`) › group (unless it repeats) › nav label.
- **Pager**: previous/next in reading order; the next major's last page leads to the Roadmap.
- **Tabs**: Docs → the version's first `docs` page; Under the hood → its first `internals` page
  (falling back to the default version's).

The page body is compiled by `@mdx-js/rollup` with `remark-gfm`, `remark-frontmatter`,
`remark-mdx-frontmatter` and `build/rehype-docs.ts`, which at build time: gives h1–h3 ids (the
old site's slug rule, de-duplicated per page; JSX `<h2 id="…">` pins one), exports
`headings` (h2/h3, for the rail), inserts `<TocInline />` after the h1 and lede, highlights fenced
code with Shiki and parses the fence meta (`title="…"`), and adds the inline-code classes the old
`app.js` added at runtime. So the prerendered HTML is already complete; nothing is rewritten in
the browser.

Each page is its own JS chunk (`import.meta.glob('/content/*/*.mdx')`, lazy). The route loader
awaits the chunk before rendering (server render and client navigation), and the router's
`hydrate` hook loads the current page's chunk before hydration, so a page never suspends and
always hydrates against identical markup.

## Versions

`src/lib/versions.ts` lists them in select order (`v7`: "v7 (current)", then `next`: "Next major"),
each with its optional `home` path (`/` for v7, `/next/` for the next major), and the default (`v7`,
used by the tabs and the not-found page outside a version). The header's version `<select>` (in the
drawer below 900px) shows on doc pages and on both homes: on a home it goes to the other version's
home (`/` ↔ `/next/`); on a doc page to the same slug in the other version if it exists, else to that
version's index. The Home tab goes to the current version's home, "Get started" to its Quickstart. A
version index without `index.mdx` (and without a home there) renders the version's first page (kept
out of search). Adding a version: an entry in `VERSIONS` and a `content/<id>/` folder.

The Roadmap (`/roadmap/…`) is version-less (its chrome shows the next major).

## Layouts and "chrome"

The root layout needs to know, before rendering, whether the page is the full-bleed **landing**
(Home: floating header over the dark hero band, no sidebar on desktop) or the three-column
**docs** layout, and which header tab is current. A route declares this as
`staticData: { chrome: { layout, tab, version? } }`, or returns `{ chrome }` from its loader when
it depends on the URL (doc pages do). `useChrome()` (`src/lib/chrome.ts`) reads the deepest
match; the header, sidebar and search read it and style themselves with utilities.

- `DocsShell` (`src/layout/DocsShell.tsx`): sidebar · main (breadcrumb, page tools, the article,
  pager, footer) · rail. Props: `nav`, `crumbs`, `pager`, `rail`, `children`. Models in
  `src/lib/nav.ts` (`NavGroup`, `Crumb`, `PagerLink`, `RailItem`).
- `LandingShell`: sidebar as mobile drawer only, `main`, then an optional `footer`.
- The rail's scroll-spy, the mobile drawer (modal, focus-trapped, closes on
  navigation/Escape/resize), copy link, print, back to top, theme toggle and toast are all in
  `src/layout/`; the inline outline (below 1200px) is `components/mdx/TocInline.tsx`.

## Styles

Styling is Tailwind v4 utilities on the components. `src/styles/app.css` is the entry: Tailwind
with its preflight, in layers `theme < base < prose < components < utilities`. The few CSS files
hold only what utilities can't express, plus named classes for markup repeated many times per
page (see `components/docs.css` below).

- `theme.css`: the Tailwind theme. Colours are `@theme inline` aliases of the tokens
  (`bg-surface` compiles to `background-color: var(--surface)`), and Tailwind's default palette is
  removed, so only the site's colours exist. Fonts (`font-sans`, `font-mono`), type sizes named by
  their px value (`text-13`, `text-12.5`, fluid `text-display`/`text-hero`/`text-section`),
  tracking (`tracking-ui`, `tracking-label`, …), radii (`rounded-box` 14px, `rounded-dialog`),
  shadows (`shadow-sm/md/lg/win/float/lift`), easings (`ease-out-quart`, `ease-out-expo`; bare
  `transition-*` defaults to .25s ease), the site's breakpoints (`2xs` 360, `xs` 480, `sm` 560,
  `home-sm` 640, `md` 768, `hdr-sm` 860, `nav` 900, `hdr` 980, `home` 1000, `lg` 1024, `home-lg`
  1100, `home-xl` 1140, `rail` 1200, `xl` 1280, `wide` 1600; a width used once stays arbitrary,
  `max-[430px]:`), containers (`max-w-article`, `max-w-landing`, `max-w-shell`, …; `@min-rm:` and
  `@min-rm-sm:` for the Roadmap's container queries), `h-header`/`top-header`/`scroll-mt-header`, animations
  (`animate-enter`, `animate-pop`, …). Variants: `dark:` (data-theme, else the OS), `js:`/`no-js:`,
  `nav-open:` (mobile drawer open). Shared utilities: `pill-on`, `eyebrow-label`,
  `scrollbar-thin`, `scrollbar-none`.
- `tokens.css`: the raw colour tokens (`--forest`, `--lime`, warm neutrals, `--syn-*` syntax
  colours, `--gx-*` Roadmap statuses, …), each written once as `light-dark(<light>, <dark>)`. The
  theme is the root's `color-scheme`: `light dark` by default (follows the OS), `light`/`dark`
  under `data-theme`, `light` in print (plus a few print-only values).
- `base.css`: element defaults on top of preflight (body, selection, focus ring, inline code,
  `pre`, `kbd`, the 16px `.icon`, reduced motion, print page setup).
- `prose.css` (layer `prose`): the article look for what MDX writes as bare HTML inside
  `<article class="doc-section">` (h1–h3, the lede, p, lists with "–" markers and numbered hairline
  rows, links, strong/em, table cells), which can't carry classes. Rules are scoped under
  `.doc-section` / `.doc-page`, wrap their element selectors in `:where()` and skip `.not-prose`
  subtrees, so `not-prose` opts a block out (widgets, Roadmap blocks, the MDX components' own
  markup). What lets any class override them is the layer, not specificity: `prose` sits below
  `components` and `utilities`.
- `components/docs.css` (layer `components`): named classes, written with `@apply`, for markup
  that repeats tens to hundreds of times per page, where inline class strings made the
  prerendered HTML much heavier: the code panel (`code-head`, `code-lang`, `copy-button`,
  `code-pre` with its scroll-fade masks), `heading-anchor`, sidebar `nav-link`, the outline's
  `toc-link` (rail and inline), the search rows (`search-hit*`), and the Roadmap's
  `feature-chip`, `feature-row`, `status-dot`, `gx-vp` pill and `todo-heading`. A variant (the
  current link, a size, a state) stays a utility on the element and always wins.
  `scripts/postbuild.ts` fails the build if any page's HTML goes over 48KB gzipped.
- `components/home.css` (layer `components`): the Studio mock's range-slider vendor
  pseudo-elements (`.home-range`), which need one rule per vendor selector, and the publishing
  timeline's dashed connectors (`.tl-linked`, pseudo-elements that flip direction below 1000px).

The docs shell (`#shell`, `DocsShell.tsx`) is full width: the sidebar is pinned to the left edge,
the rail to the right, and the middle column takes the rest. Inside it every child of `main`
(breadcrumb row, article, pager, footer) shares one centred reading column, `max-w-article`
(720px), widening to `max-w-article-wide` (800px) from 1600px; code, tables and callouts keep the
text's edges. Above 1920px the shell and the docs header row cap at `max-w-shell` and centre, and
the sidebar's background runs to the window edge. The landing keeps its own 1200px container.

Theme: an inline script (`ScriptOnce` in `<head>`) applies `?theme=dark|light` or the saved choice
(`localStorage['deco-blocks-docs-theme']`) as `data-theme` before first paint. No attribute
means "follow the OS".

## Search

`scripts/postbuild.ts` runs Pagefind's Node API over the prerendered HTML: only elements with
`data-pagefind-body` are indexed (doc articles have it; Home and the Roadmap opt in by adding it),
and each page is indexed under its route (`/next/quickstart`). The bundle lands in
`dist/client/pagefind/`; in the browser, `import(`${import.meta.env.BASE_URL}pagefind/pagefind.js`)`
(with `/* @vite-ignore */`) loads it, and results come back with the base path prepended. Headings
have ids, so sub-results link to `#anchors`. It only exists after a build (not in `dev`).

The dialog is `components/search/index.tsx` (default export), mounted by `src/layout/GlobalUi.tsx`
if present. The header ⌘K button, the drawer's search button and the shortcuts (⌘K, Ctrl+K, `/`)
dispatch the `docs:search-open` window event (`SEARCH_OPEN_EVENT` / `openSearch()` in
`src/lib/ui.ts`); the dialog listens for it.

## Home, Roadmap, widgets

The routes pick these up with `import.meta.glob`, so each folder can be built independently:

- **Home**: `components/home/index.tsx` default export `Home({ version })` renders a version's
  whole landing: `/` renders v7's (`components/home/v7/`), `/next/` the next major's (the rest of
  `components/home/`). Both sit in `HomeFrame` (`Frame.tsx`): `<LandingShell nav={sidebarFor(version,
  'docs')} footer={<SiteFooter columns={…}/>}>`, so the drawer and the footer columns follow the
  version (`NEXT_COLUMNS` in `Footer.tsx`, `V7_COLUMNS` in `v7/columns.ts`). The v7 home reuses the
  next major's pieces (hero band, journey carousel, cards, status window, publishing timeline,
  `StepperShell`). The `$version/index` loader must not reference the home module (loaders stay in
  the entry chunk; only the component is split). Styled with utilities (shared pieces in
  `components/home/ui.tsx`); the
  cobogó defs are `assets/cobogo-defs.svg` (imported `?raw`), brand marks in
  `components/ui/Brand.tsx`, icons in `components/ui/Icon.tsx`.
- **Roadmap**: one page per section of the old Roadmap (it showed one section at a time):
  `/roadmap/` is the overview, `/roadmap/blockers`, `/roadmap/api`, … the rest
  (`components/roadmap/sections.ts` maps sections and ids to URLs; the routes are
  `src/routes/roadmap/`). `model.ts` checks data/roadmap.json and derives everything shown;
  `SectionViews.tsx` renders a section (router-free markup, so `scripts/check-roadmap.ts` can render
  and check it); `RoadmapPage.tsx` puts it in `<DocsShell>` and handles client-side links, the
  feature filter and deep links to filtered-out rows. Route `head()`s import only `sections.ts`
  (pure TS, which also holds the section labels for document titles): anything that imports the
  data from a `head()` lands in the entry chunk every page loads, and `scripts/postbuild.ts` fails
  the build if Roadmap data shows up there. It's styled with utilities in `SectionViews.tsx`
  (statuses map to the `--gx-*` tokens there); it has no stylesheet of its own. The route's chrome is
  `{ layout: 'docs', tab: 'roadmap' }`. Links from content may use `/roadmap#<id>`: `MdxLink`
  resolves it to the page holding the id.
- **Widgets**: capitalized named exports of `components/widgets/index.tsx` become MDX components
  (`<Walkthrough />`).

Shared helpers for all of them: `toast`, `announce`, `copyText`, `openSearch`, `closeMenu`
(`src/lib/ui.ts`); `CopyButton` (`components/mdx/CodeBlock.tsx`).

## Prerendering and the base path

`vite.config.ts` gives TanStack Start's prerenderer an explicit page list: `/`, the Roadmap pages, each
version index and every manifest page (no crawling). Each becomes `dist/client/<path>.html`
(`next/quickstart.html`, `roadmap/api.html`; indexes `v7/index.html`, `roadmap/index.html`), which GitHub Pages
serves at the extension-less URL without a redirect. `404.html` is rendered after the build by the
built server handler for an unmatched URL, so it hydrates cleanly as the router's not-found state.

Links: write `to="/next/quickstart"` (TanStack `<Link>`) or `[x](/next/quickstart)` in MDX; the
router adds the base path. Static files from `public/` need `import.meta.env.BASE_URL`.

## Checks

- `bun run check`: types, frontmatter, h1 vs title, inter-page links and heading anchors in MDX,
  no local filesystem paths in content; then `scripts/check-roadmap.ts` (also the first step of
  `bun run build`): the Roadmap data, its rendered pages (ids, counts, wording, every link) and
  the docs' links into it.
- `bun run build`: fails if a page fails to render, or (post-build) on any internal link in the
  rendered HTML whose page or `#fragment` doesn't exist, Roadmap anchors included.

## Public-content policy

This folder is published (public repository and public site). Only commit what anyone may read:
no credentials, no private repository names or code, no customer names, no local paths, no live
security issues. See README.md.
