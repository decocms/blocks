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
│   ├── next/*.mdx            the next major (served at /next/<file name>)
│   └── v7/*.mdx              the current release (/v7/…); index.mdx is /v7/
├── components/
│   ├── mdx/                  components MDX pages use (API: components/mdx/README.md)
│   ├── ui/                   Icon/Mark (the icon set), Brand (wordmark, symbol)
│   ├── home/                 the Home page: index.tsx default export (see "Home")
│   ├── roadmap/              the Roadmap pages, from data/roadmap.json (see "Roadmap")
│   ├── widgets/              interactive MDX widgets: named exports of index.tsx
│   └── search/               the ⌘K dialog: index.tsx default export (see "Search")
├── data/roadmap.json         the Roadmap's data
├── src/                      the app (TanStack Start's srcDirectory)
│   ├── router.tsx            createRouter: basepath, scroll restoration, hydrate hook
│   ├── routes/               file-based routes (routeTree.gen.ts is generated, and committed)
│   │   ├── __root.tsx        <html>, head (fonts, CSS, theme script), header, global UI
│   │   ├── index.tsx         /            Home
│   │   ├── roadmap/          /roadmap/    Roadmap overview (index.tsx), /roadmap/<section> ($section.tsx)
│   │   └── $version/
│   │       ├── index.tsx     /next/, /v7/ the version's index
│   │       └── $slug.tsx     /next/quickstart … a doc page
│   ├── layout/               Header, Sidebar, DocsShell (+ LandingShell), Rail, DocPage, NotFound, …
│   ├── lib/                  content (manifest + page loading), nav models, chrome, theme, ui, versions
│   └── styles/               app.css (entry) → tokens.css, legacy.css, prose.css
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

`src/lib/versions.ts` lists them (`next`: "Next major", `v7`) and the default (`next`, used by Home,
"Get started" and the tabs outside a doc page). The header's version `<select>` (in the drawer on
small screens) goes to the same slug in the other version if it exists, else to that version's
index. A version index without `index.mdx` renders the version's first page (kept out of search).
Adding a version: an entry in `VERSIONS` and a `content/<id>/` folder.

The Roadmap (`/roadmap/…`) and Home (`/`) are version-less.

## Layouts and "chrome"

The root layout needs to know, before rendering, whether the page is the full-bleed **landing**
(Home: floating header over the dark hero band, no sidebar on desktop) or the three-column
**docs** layout, and which header tab is current. A route declares this as
`staticData: { chrome: { layout, tab, version? } }`, or returns `{ chrome }` from its loader when
it depends on the URL (doc pages do). `__root.tsx` reads the deepest match and sets
`<body data-layout data-page>`, which the CSS keys off, exactly as the old single page did.

- `DocsShell` (`src/layout/DocsShell.tsx`): sidebar · main (breadcrumb, page tools, the article,
  pager, footer) · rail. Props: `nav`, `crumbs`, `pager`, `rail`, `children`. Models in
  `src/lib/nav.ts` (`NavGroup`, `Crumb`, `PagerLink`, `RailItem`).
- `LandingShell`: sidebar as mobile drawer only, `main`, then an optional `footer`.
- The rail's scroll-spy, the inline outline, the mobile drawer (modal, focus-trapped, closes on
  navigation/Escape/resize), copy link, print, back to top, theme toggle and toast are all in
  `src/layout/`.

## Styles

`src/styles/app.css` is the entry: Tailwind v4 **without preflight** (the ported CSS expects
browser defaults), in layers `theme < base < legacy < components < utilities`.

- `tokens.css`: the design tokens (`--forest`, `--lime`, warm neutrals, `--syn-*` syntax colours,
  …) for light, dark (`prefers-color-scheme`, overridden by `data-theme`) and print.
- `legacy.css`: the old `style.css`, verbatim apart from the tokens and the rules that switched
  hash-routed pages. It is the source of the look (header, sidebar, rail, prose, code panels,
  tables, callouts, flows, landing, search dialog, responsive, print).
- `prose.css`: doc pages put the title in an h1 and sections in h2/h3, where the old page had
  h2/h3/h4; this maps those levels to the old styles (`article.doc-section.doc-page`), plus the
  version select.

The tokens are also Tailwind theme values (`bg-bg`, `text-fg`, `text-muted-fg`, `border-hairline`,
`bg-forest`, `text-lime`, `font-mono`, `shadow-deco-win`, …), and the `dark:` variant follows the
same rule as the tokens. New code can use utilities or the existing classes.

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

- **Home**: `components/home/index.tsx` default export renders the whole page, inside
  `<LandingShell nav={sidebarFor(DEFAULT_VERSION, 'docs')} footer={<SiteFooter/>}>…</LandingShell>`
  (the drawer shows the Docs navigation). Its classes are in `legacy.css`; the cobogó defs are
  `assets/cobogo-defs.svg` (imported `?raw`), brand marks in `components/ui/Brand.tsx`, icons in
  `components/ui/Icon.tsx`.
- **Roadmap**: one page per section of the old Roadmap (it showed one section at a time):
  `/roadmap/` is the overview, `/roadmap/blockers`, `/roadmap/api`, … the rest
  (`components/roadmap/sections.ts` maps sections and ids to URLs; the routes are
  `src/routes/roadmap/`). `model.ts` checks data/roadmap.json and derives everything shown;
  `SectionViews.tsx` renders a section (router-free markup, so `scripts/check-roadmap.ts` can render
  and check it); `RoadmapPage.tsx` puts it in `<DocsShell>` and handles client-side links, the
  feature filter and deep links to filtered-out rows. Route `head()`s import only `sections.ts`
  (pure TS, which also holds the section labels for document titles): anything that imports the
  data from a `head()` lands in the entry chunk every page loads, and `scripts/postbuild.ts` fails
  the build if Roadmap data shows up there. Its stylesheet (`roadmap.css`, in the
  `legacy` layer) is linked from the routes' `head`. The route's chrome is
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
