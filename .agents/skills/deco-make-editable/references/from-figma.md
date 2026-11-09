# From a Figma file to editable sections

The same method as a hardcoded site, with the design as the source: map the
file, build each section with typed props, seed the blocks with the design's
content, then compare with the design (see [pixel-parity.md](./pixel-parity.md)).

The Figma tools named here (`get_metadata`, `get_design_context`,
`get_screenshot`, `get_variable_defs`) belong to the Figma MCP server, not to
this repo. Follow that server's own instructions: it may ask for a session or
a design-to-code skill before the first read.

## 1. Map the file

Take the file key from the URL (`figma.com/design/<fileKey>/<name>?node-id=1-2`;
a `node-id` of `1-2` is node `1:2`). Call `get_metadata` on the root node to
list pages and their top-level frames.

Map Figma pages to routes, and say which ones are not pages:

| Figma page | Route | Shape |
|---|---|---|
| Home | `/` | composed page |
| Landing / Campaign | `/campaign/...` | composed page |
| Institutional (About, Contact) | `/about`, `/contact` | composed page |
| Blog | `/blog`, `/blog/:slug` | collection (see [content-shapes.md](./content-shapes.md)) |
| Product listing, product detail, search, cart | the site's commerce routes | sections fed by loaders; see `deco-site-authoring` and `deco-apps` |
| Components / Design system | none | reusable parts, not a page |

Call `get_metadata` on each page node. Each top-level frame is usually one
section. Record for each: node id, name, page, width and position (top to
bottom is render order).

- **Desktop and mobile:** frames named `Hero - Desktop` and `Hero - Mobile`
  are one section with two layouts. Frames wider than 1024px are desktop;
  375px is the usual mobile width. With only a desktop frame, build the mobile
  layout with responsive styles and confirm it with the designer.
- **Shared or page-specific:** the header and footer appear on every page:
  global blocks. A newsletter band on several pages is one section type used
  in several pages, not a global block, unless editors want to change it in
  one place.

## 2. The section map

Before writing code, produce a table and get the user's confirmation:

| # | Section | Figma page | Node | Shape | Variants | Data | Interactive parts |
|---|---|---|---|---|---|---|---|
| 1 | Header | all | 12:34 | global block | desktop, mobile | none | mobile menu, search |
| 2 | Hero | Home | 12:56 | page section | desktop, mobile | none | carousel |
| 3 | ProductShelf | Home | 13:10 | page section | desktop | product list loader | none |

Build in this order: header, footer, the home's first section, the rest of the
home top to bottom, then the other pages. The header and footer are on every
screenshot, so getting them right first makes every later comparison cleaner.

## 3. Design tokens

Call `get_variable_defs` on a frame to read the file's variables (colors,
spacing, type, radii). Match them to the site's existing theme first (Tailwind
config, CSS variables). Add a token only when no existing one matches, and
name it as the design names it. A section that hardcodes `#1a1a2e` where the
theme has `--color-secondary` drifts the first time the brand changes.

## 4. Build each section

Call `get_design_context` on the frame (and on its mobile frame). It returns
reference markup, a screenshot and asset URLs. The markup is a reference to
adapt to the site's components and tokens, not code to paste.

For each section:

- **Props are the content.** Every text, link, image and list an editor could
  change is a prop. Type them for the form (`deco-cms-schema`); an image is a
  string typed `ImageWidget` (from `@decocms/compat-v7/types/widgets`, or any
  local `type ImageWidget = string`: `deco schema` reads the name) so Studio
  shows an image picker.
- **No content in default values.** The design's texts go into the seeded
  blocks ([seeding-content.md](./seeding-content.md)), not into default
  parameters. Defaults in code are a second copy of the content.
- **Interactive parts are small client components.** A carousel, an accordion
  or a menu drawer is its own component with state; the section around it
  stays plain. The examples in this repo mark such components `"use client"`,
  which matters for React Server Components (Next.js). Pass them serializable
  props only. `deco-site-authoring` covers this.
- **Data comes from loaders.** A shelf that shows products takes them from a
  loader block, not from a fetch inside the component. See
  `deco-site-authoring` and `deco-apps`.
- **Images:** render with `Image` or `Picture` from `@decocms/tanstack/react`
  (or `next/image` with the deco loader on Next.js), always with `width` and
  `height`. Set `preload` on the one image that is the page's LCP, usually the
  first hero image; every other `Image` loads lazily by default.
- Add the section to the block map and run `deco schema`.

## 5. Assets

The asset URLs from `get_design_context` are temporary Figma exports. Download
them, prefer the original files when the designer can export them, and put
them where the site's images live. The `deco` CLI has no asset upload command;
`deco-images-media` covers where images go and how their URLs are served.
Use the final URLs in the seeded blocks.

## 6. Assemble the pages

Write one `page` block per Figma page, with its sections in the design's order
and the design's content in each section
([content-shapes.md](./content-shapes.md#composed-pages)). Write the global
blocks (header, footer). Run `deco check`, or push to a draft and run
`deco check --draft=<name>` on a hosted site.

Then compare with the design: [pixel-parity.md](./pixel-parity.md#against-a-figma-design).
