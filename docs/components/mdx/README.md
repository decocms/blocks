# MDX components

Everything a page under `content/<version>/*.mdx` can use. The map is `mdxComponents` in
[`index.tsx`](./index.tsx); pages get it automatically (no imports in MDX files).

Plain Markdown covers most of a page: paragraphs, `**bold**`, `` `code` ``, lists, links, GFM
tables, fenced code. The components below cover what Markdown can't.

## Page structure

```mdx
---
title: Quickstart          # = the h1's plain text (checked)
nav: Quickstart            # sidebar label (defaults to title)
group: Getting started     # sidebar group
kind: docs                 # docs | internals (Under the hood); default docs
order: 2                   # position in the version's reading order
eyebrow: Getting started   # small label above the h1; defaults to group
description: …             # optional <meta name="description">
---

# Quickstart

The first paragraph after the h1 is the lede (larger, muted).

## A section          ← h2: in the "On this page" rail, gets a permalink
### A sub-section     ← h3: indented in the rail
```

- One `# h1` per page, first thing after the frontmatter. The layout renders the eyebrow above
  it; the inline "On this page" outline is inserted after the h1 and its lede automatically.
- Heading ids are generated from the text with the old site's slug rule (`## 1. Make the
  function configurable` → `#1-make-the-function-configurable`, duplicates get `-2`, `-3`). To
  pin an id, write the heading as JSX: `<h2 id="publishing">Publishing</h2>` (it still gets the
  permalink and rail entry).

## Links

```mdx
[Quickstart](/next/quickstart)               another page (client-side navigation)
[Publishing](/next/releases-and-deployment#publishing)      a heading on another page
[Roadmap](/roadmap#roadmap-api)              the Roadmap (version-less)
[Key terms](#key-terms)                      a heading on this page
[GitHub](https://github.com/decocms/blocks)  external
```

Root-relative, **without** the base path (`/blocks/` on GitHub Pages is added for you). Old
single-page anchors map like this: `#quickstart` → `/next/quickstart`,
`#releases-and-deployment--publishing` → `/next/releases-and-deployment#publishing` (drop the
`<section id>--` prefix), `#roadmap-…` → `/roadmap#roadmap-…`. `bun run check` and the build
fail on links to pages or headings that don't exist.

## Code blocks

Fenced code; the meta after the language sets the header.

````mdx
```ts title="cms.ts"
export const cms = createCMS({ blocks, content });
```
````

| Fence | Renders |
|---|---|
| ` ```ts title="cms.ts" ` | Header with file icon and `cms.ts` in mono, a "TypeScript" badge, Copy. (Was `<figure class="code-example"><figcaption>cms.ts</figcaption>`.) |
| ` ```tsx title="blocks.tsx (Next.js)" ` | Path in mono, the note after it in text. |
| ` ```json title="A plain request handler" ` | A description rather than a path: plain-text header. |
| ` ```ts ` (no title) | Header shows the language ("TYPESCRIPT"), Copy. (Was `<pre class="code-block">`.) |
| ` ```bash ` with one line starting `npm`/`npx`/`pnpm`/`yarn`/`bun` | Compact `$ command` pill. |
| ` ```bash ` with a URL alone | Labelled "URL". |
| ` ```text ` containing `│` box drawing | Diagram line height. |

Languages: `ts`/`typescript`, `tsx`, `js`, `jsx`, `json`, `jsonc`, `bash`/`sh`, `yaml`, `html`,
`css`, `diff`, `text`. A `ts` block that contains JSX is highlighted as TSX automatically (the old
rule). Highlighting is Shiki at build time with a CSS-variable theme (`--syn-*` tokens), so it
follows light/dark/print. Write code verbatim (no HTML entities): `a && b`, `<T>`.

## Components

### `<Callout>`

```mdx
<Callout>**Status.** The API on these pages is proposed and not released yet.</Callout>

<Callout type="warning">

**Don't** call `createCMS` per request.

A second paragraph.

</Callout>
```

`type`: `note` (default, info icon; was `.callout`), `warning` (amber; was `.callout.warning`),
`preview` (lime dot; was `.intro-note`). Inline content on one line becomes one paragraph.

### `<Hosted>`

```mdx
<Hosted to="/next/hosted-publishing">**Skip the deploy wait.** With the hosted Deco CMS, a commit to your production branch is served as a release within seconds, and running servers pick it up within about a minute, with no rebuild.</Hosted>

<Hosted to="/next/hosted#connect-your-site" label="Connect your site">…</Hosted>
```

A notice on a framework page saying what the hosted Deco CMS changes there, with a link to the
hosted page that explains it. Renders an `<aside aria-label="Hosted Deco CMS: <label>">` (so several on a page stay distinguishable): a lime box with a
forest left rule (lime in dark mode), a "Hosted Deco CMS" eyebrow with a dot, the text, and the
link (`label`, default "How the hosted Deco CMS does it", then →). `to` is required: a
root-relative docs path, optionally with `#hash`; it goes through `MdxLink`, and `bun run check`
validates it like any link. Inline content on the tag's line becomes one paragraph.

Rules for writers:

- The framework page stays complete without it: put it **after** the core instructions, never
  instead of them.
- One or two sentences of factual benefit (what changes, how fast), no "upgrade" language.
- At most one per section and two per page; never on the hosted pages themselves.
- `to` points at a hosted page (`/next/hosted`, `/next/hosted-*`).

### Tables

GFM tables render inside a scrolling, bordered wrapper (the `table` override). Inline code in a
cell that contains spaces may wrap on phones; single identifiers don't.

```mdx
| Piece | What it does |
|---|---|
| **SDK** `@decocms/blocks` | Reads your content… |
```

If a cell needs a list or several paragraphs, write the table as JSX (`<table><thead>…`); it
still gets the wrapper.

### `<Flow>` / `<FlowNode>`

```mdx
<Flow label="Authoring flow">
  <FlowNode title="Your TypeScript">Functions with typed inputs: UI and data fetchers alike</FlowNode>
  <FlowNode title="CLI → JSON Schema">`deco schema` writes `.deco/schema.json`</FlowNode>
  <FlowNode title="Studio">Forms and previews for editors, built from the schema</FlowNode>
</Flow>
```

Numbered cells with arrows between them (drawn automatically); stacks on phones. `title` takes
JSX: `title={<><code>load()</code> from memory</>}`. Keep each node's text on the tag's line.
Was `.flow > .flow-node + .flow-arrow`.

### `<Terms>` / `<Term>`

```mdx
<Terms>
  <Term name="Block function">One of your functions with a typed first parameter. See [Quickstart](/next/quickstart).</Term>
  <Term name="Block map">A plain object of your block functions, such as `{ experiments }`.</Term>
</Terms>
```

Was `<dl class="terms">`.

### `<Small>`

```mdx
<Small>Top: four route paths. Below: the trie built from them.</Small>
<Small style={{ margin: '18px 0 6px' }}>Background path · on first use, then about once a minute</Small>
```

A small muted line (diagram captions, labels above a Flow). Was `<p class="small muted">`.

### `<Steps>` / `<Step>`

A Markdown ordered list (`1. …`) already renders as the numbered hairline rows. `<Steps>` +
`<Step>` produce the same `<ol><li>` when a step needs JSX or nested blocks.

### `<Kbd>`, `<Eyebrow>`

`<Kbd>⌘K</Kbd>`. `<Eyebrow>` is the uppercase label (the layout already puts one above the h1).

## Widgets

Interactive pieces (the "How resolution works" walkthrough, …) live in `components/widgets/`.
Every capitalized export of `components/widgets/index.tsx` is added to this map, so a page writes
`<Walkthrough />` with no import. A page that uses a name nobody exports fails to render.

### `<Walkthrough />`

```mdx
Step through `client.resolve("SummerCard")` to watch [the lookup rule](/next/blocks#the-lookup-rule) at work, …

<Walkthrough />
```

The "How resolution works" explorer (was `<div class="explorer">` + the `trace-*` script in
app.js): the CMS-call toggle (`resolve("SummerCard")` / `{ run: false }`), the output toggle
(Descriptor / React tree), the four step pills, the code at that step, its caption and call count,
and "Next step →". It takes no props; its data (captions, counts) is in
`components/widgets/Walkthrough.tsx` and the code for each state in
`components/widgets/walkthrough-code.mdx` (highlighted at build time like any fence). Write the
surrounding prose in the page; the widget renders only the explorer box. Use it once per page
(it keeps the old element ids: `#trace-code`, `#trace-caption`, `#trace-stat`, `#trace-next`).

## Internal (don't write these)

- `TocInline`: inserted after the h1/lede by `build/rehype-docs.ts`.
- `H1`/`H2`/`H3`, `MdxLink`, `CodeBlock`, `Table`: the element overrides behind headings, links,
  fenced code and tables.

## Styling

- What these components render carries Tailwind utilities in the TSX (theme: `src/styles/theme.css`).
  The code panel's parts and the heading permalink repeat many times per page, so they use named
  classes written with `@apply` in `src/styles/components/docs.css` (`code-head`, `code-pre`,
  `copy-button`, `heading-anchor`, …).
- What MDX writes as bare HTML (h1–h3, the lede, p, lists, links, strong/em, table cells) can't carry
  classes, so it's styled by the prose layer, `src/styles/prose.css`: rules scoped to
  `.doc-section`, in their own cascade layer below every class, so any utility wins over them.
- `not-prose` on an element opts it and its contents out of the prose layer (widgets, Roadmap
  blocks, the inline outline).
- Shared pieces for markup outside MDX: `<Eyebrow>` / `EYEBROW`, `<Small>` / `SMALL`,
  `<Callout>` / `calloutClass(type)`, `<HeadingAnchor>`.
- Hook classes kept for scripts: `heading-anchor`, `toc-inline`, `code-head`, `code-lang`,
  `copy-button` (the search index skips them), and `fade-l` / `fade-r` / `fade-b` on a scrolling
  `<pre>` (toggled by CodeBlock).

## Adding a component

Add a file here, export it from `index.tsx` and add it to `mdxComponents`, then document it in
this file. Keep it server-renderable (the page is prerendered); client-only behaviour goes in
`useEffect`.
