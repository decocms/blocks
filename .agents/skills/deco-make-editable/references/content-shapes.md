# The three content shapes

Every piece of content from the [inventory](./inventory.md) takes one of three
shapes. Pick the shape first; the code follows from it.

| Shape | Use for | Saved as | Read with |
|---|---|---|---|
| **Global block** | Things on every page: header menu, footer, a top banner | One saved block with a fixed name, e.g. `.deco/blocks/Header%20menu.json` | `client.resolve("Header menu")` in a loader shared by every page |
| **Composed page** | Pages editors rearrange: home, landings | A saved block of type `page` with `name`, `path`, `seo` and `sections` | `client.routes()` + `matchRoute`, then `client.resolve(name)` |
| **Collection** | Many documents of one kind: articles, FAQ entries, store addresses | One saved block per document, all of one type | `client.list(type, { where, sort, limit })` |

A saved block's file name is `encodeURIComponent(name) + ".json"`, so the
block named `Header menu` lives in `Header%20menu.json`. Subfolders of
`.deco/blocks` are not read. A saved block cannot take the name of a block
type or a built-in (`page`, `lazy`, `multivariate`, …): `deco check` reports
it.

The site wiring around these (the client, the catch-all route, the worker) is
in `deco-tanstack-site` or `deco-nextjs-site`. The examples below assume a
TanStack Start site with `src/cms.ts` exporting `cms` from `createCMS`, as in
`examples/tanstack-worker-smoke`.

## Sections: JSX or descriptors

A block function that returns JSX, or a `{ component, props }` object, is a
section: Studio offers it wherever a section fits. The TanStack examples in
this repo return descriptors, because a server function's result must be
serialized; the site maps each descriptor to its component when it renders.
The Next.js examples return JSX from the block map (`.deco/index.tsx`).

```ts
// .deco/index.ts
import type { Blocks, Seo } from "@decocms/blocks";
import type { HeaderMenuProps } from "../src/sections/HeaderMenu";
import type { HeroProps } from "../src/sections/Hero";

export type Section =
  | { component: "header-menu"; props: HeaderMenuProps }
  | { component: "hero"; props: HeroProps };

export default {
  seo: (input: Seo) => input,
  "header-menu": (input: HeaderMenuProps): Section => ({ component: "header-menu", props: input }),
  hero: (input: HeroProps): Section => ({ component: "hero", props: input }),
} satisfies Blocks;
```

Run `deco schema` after every change to a `Props` type, and commit the
regenerated `.deco/schema.gen.json`. In CI, `deco schema --check` fails when
the file is out of date.

## Global blocks

One saved block per piece, named for what editors call it:

```json
// .deco/blocks/Header%20menu.json
{
  "__resolveType": "header-menu",
  "links": [
    { "label": "Pricing", "href": "/pricing" },
    { "label": "Docs", "href": "/docs" }
  ]
}
```

Read it once per request, in a loader every page shares (the root route on
TanStack Start), and hand the result to the layout:

```ts
// src/global-blocks.functions.ts
import { createServerFn } from "@tanstack/react-start";
import { contentClient } from "@decocms/tanstack/server";
import type { Section } from "../.deco";
import { cms } from "./cms";

const GLOBAL_BLOCKS = ["Header menu", "Footer"] as const;

export const loadGlobalBlocks = createServerFn({ method: "GET" }).handler(async () => {
  const client = contentClient(cms);
  const results = await Promise.all(GLOBAL_BLOCKS.map((name) => client.resolve<Section>(name)));
  return Object.fromEntries(
    GLOBAL_BLOCKS.map((name, i) => {
      const [value, error] = results[i]!;
      if (error) console.error(name, error);
      return [name, value ?? null];
    }),
  ) as Record<(typeof GLOBAL_BLOCKS)[number], Section | null>;
});
```

What held up in practice:

- **List the global block names in one place.** A missing block then shows up
  as one `null` you can test for, not as a header that silently renders empty.
- **No fallback copy in code.** When a block cannot be read, render nothing (or
  the section's empty state) and log the error. A constant with the old menu
  becomes a second source of truth that drifts from what editors see.
- **Derive what editors should not manage.** The active menu item comes from
  comparing `href` with the current path, not from an extra field.
- **External links** in CMS lists still need `target="_blank"` and
  `rel="noopener noreferrer"`. Set them in the component from the URL, not
  from a field editors can forget.

## Composed pages

A page is a saved block of the built-in type `page`. Its `sections` are the
blocks editors add, remove and reorder:

```json
// .deco/blocks/Home.json
{
  "__resolveType": "page",
  "name": "Home",
  "path": "/",
  "seo": { "__resolveType": "seo", "title": "…", "description": "…" },
  "sections": [
    { "__resolveType": "hero", "title": "…", "cta": { "label": "…", "href": "/start" } },
    { "__resolveType": "guides", "items": [] }
  ]
}
```

The page loader in `examples/tanstack-worker-smoke/src/open-page.server.ts`
does the rest: `client.routes()` lists every page's `{ name, path }` from the
index, `matchRoute(href, { routes })` picks one, and `client.resolve(name, {
run: false })` reads it, then each section resolves on its own so a slow one
does not hold the others. `deco-tanstack-site` covers the catch-all route that
calls it.

**Keep your routes.** You do not have to hand the whole site to a catch-all
route to get CMS pages. A site with content files, locale prefixes or
redirects of its own can keep its file routes and call the same page loader
only in the routes that are now CMS pages (`loadPage({ data: { href: "/" } })`
in `src/routes/index.tsx`). On TanStack Router a file route such as `/` ranks
above the `$` catch-all, so converting one route never changes the others.

**Keep the frame in code.** The header and footer around a page stay in the
layout, fed by global blocks. A page's `sections` hold only what changes from
page to page.

**Render no wrapper you did not have.** The site writes the loop that renders
each section. If the old page had no element around each section, do not add
one: an extra `<div>` breaks CSS such as `.page > section` and fails the
[HTML parity](./pixel-parity.md) check.

**The tab title can come from the page.** The `page` block's `seo` field takes
any block that returns a `Seo` (`{ title, description }`), such as the `seo`
block in the map above. A page without one falls back to the root route's
defaults.

## Collections

A collection is a block type whose function returns its own input, with one
saved block per document:

```ts
// src/post.ts
import type { Route } from "@decocms/blocks";

export interface Post extends Route {
  /**
   * @title Published on
   * @format date
   */
  date: string;
  /** @format rich-text */
  body: string;
}

// .deco/index.ts
post: (input: Post) => input,
```

Because `Post` extends `Route` (`name` and `path`), each post is routed like a
page: `client.routes()` finds it by path. A type without `path` is plain
content that only the site's code reads.

List them with `client.list`:

```ts
const [posts, error] = await client.list<Post>("post", {
  sort: (a, b) => b.date.localeCompare(a.date),
  limit: 20,
});
```

`list` reads every saved block of that type whole. That is fine for an index
of tens of documents. For routing, use `client.routes()`, which reads only the
index: `list("page")` warns outside production for that reason.

See `examples/nextjs-binding-smoke/src/app/blog/page.tsx` for a list page.
