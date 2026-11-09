# Pages

A page is a saved block of the built-in type `page`. It lives at
`.deco/blocks/<name>.json` (the file name is `encodeURIComponent(name)`), and the site's
catch-all route finds it by path with `matchRoute`.

```json
{
  "__resolveType": "page",
  "name": "Summer shirt",
  "path": "/:slug/p",
  "seo": { "__resolveType": "seo", "title": "Summer shirt", "description": "Light cotton shirt." },
  "sections": [
    { "__resolveType": "Header" },
    { "__resolveType": "product-hero", "name": "Summer shirt", "price": 49, "currency": "USD", "image": "/images/summer-shirt.jpg" },
    { "__resolveType": "Footer" }
  ]
}
```

The resolved type is `Page<Section>` from `@decocms/blocks`: `name` and `path` (from
`Route`), an optional `seo` and `sections`. The built-in `page` returns its inputs as
they are, so a resolved page is `{ name, path, seo, sections }` with every section
resolved. Without `seo`, the site's defaults apply (see [seo.md](./seo.md)).

Create or edit pages in Studio, or edit the JSON and send it with the `deco` CLI (see
the `deco-site-workflow` skill). There is no `website/pages/Page.tsx` type to write.
v7 content that still says so resolves through a legacy alias.

## Paths

`path` is a template. `matchRoute` compiles all paths into a segment tree and tries, at
each segment, the literal child first, then a `:param` child, then a trailing `*`. So
`/sale` beats `/:slug`, and `/:slug` beats `/*`.

| Template | Matches | `params` |
|---|---|---|
| `/about` | `/about` | `{}` |
| `/:slug/p` | `/summer-shirt/p` | `{ slug: "summer-shirt" }` |
| `/blog/:slug` | `/blog/archive` | `{ slug: "archive" }` |
| `/c/*` | `/c/shoes/running` | `{ "*": "shoes/running" }` (one or more segments) |

- The URL is percent-decoded, its query and fragment are dropped, and a trailing slash
  is removed before matching. A `:param` never holds a slash.
- A splat is only a trailing `*` segment. v7's `/:slug*` form is not v8 syntax.
- Two pages whose paths reach the same leaf (`/:a/p` and `/:b/p`) conflict. `deco check`
  reports it, and at runtime the page whose saved name sorts first wins.

## How a page is opened

The binding's page loader (`src/open-page.server.ts` in the examples and in what the
migration script writes) does this per request. You rarely change it, but you need it
in mind to know what reaches your blocks.

1. `client.routes()`: `{ name, path }` of every page, from the content index. `name`
   is the saved block's name.
2. `matchRoute(href, { routes })`: `match` with `entry` and `params`, or `not-found`.
3. `client.prefetch(entry.name)`: starts downloading the page and everything it
   references, in parallel with the next step.
4. `client.redirects()` and `matchRoute(href, { routes: [], redirects })`: a redirect
   wins over a page at the same path.
5. `client.resolve(entry.name, { run: false })`: the page as JSON, saved references
   expanded, nothing run.
6. In the TanStack examples: one `client.resolve(section)` per section, each its own
   promise, plus `seo`. The route renders each promise in its own Suspense boundary.
   See [lazy-blocks.md](./lazy-blocks.md). The Next.js examples skip step 5 and
   resolve the whole page in one call (`client.resolve(entry.name)`), so there one
   failing block fails the page.

The wiring of that file, the route and `head()` belong to the `deco-tanstack-site` and
`deco-nextjs-site` skills.

## Route params reach blocks as arguments

A block function never sees the URL. `matchRoute` returns `params` to the page loader,
and the page loader passes them on. With a section read in step 5, add the param as an
argument when you resolve it:

```ts
const { slug } = match.params;
const [hero, error] = await c.resolve({ ...section, slug });
```

For an inline block, the extra field becomes one of its inputs. For a reference to a
saved block, it is merged over the saved block's own fields (shallow,
`{ ...saved, ...arguments }`). Only the top-level block gets it. A loader nested inside
the section does not. The section passes `slug` down itself (see
[loaders.md](./loaders.md)). Decide one name per param (`slug`) and use it in every
block that needs it, so the page loader can pass the same arguments to all of them.

A page loader that resolves the whole page in one call has no per-section step. Passing
`slug` to `resolve({ __resolveType: entry.name, slug })` only reaches the `page` block
itself, not its sections. Resolve the sections one by one to pass params.

This is the page loader's choice, not a framework rule. Read the site's
`open-page.server.ts` before you assume a block gets a param. The v7 way,
`website/functions/requestToParam.ts` in content, has no v8 block.

## Shared header and footer

Save shared sections once as named blocks (`Header.json`, `Footer.json`) and reference
them by name in each page:

```json
{ "__resolveType": "Header" }
```

A reference resolves to the saved block. Fields you add next to `__resolveType` replace
the saved block's fields of the same name, for that page only. Copy the references from
the home page when you create a page, so every page shows the same header and footer.

## Variants of a page's sections

`sections` can be a list, or one `multivariate` block whose variants are whole lists.
The page loader handles both: a single block resolves to the chosen list. Use the whole
list form when an A/B test changes the layout, and per-section variants when it
changes one section. See the `deco-variants` skill.

## Changing the page type

- **Extra fields on every page.** Add a `page` key to the block map. It replaces the
  built-in, and its Props type becomes the page form:

  ```ts
  interface StorePage extends Page {
    theme: "light" | "dark";
  }
  export default { page: (props: StorePage) => props /* , ... */ } satisfies Blocks;
  ```

  `deco check` warns that Studio's page list and editor rely on the built-in `page`.
  Keep the same fields so they keep working. The `seo` field then follows your type:
  Studio offers a block for it only if the block's return type fits that type.

- **A routable type of your own** (blog posts, store locator entries). Make its Props
  extend `Route` (`name` and `path`). A block whose Props have a `path` field but do not
  extend `Route` is an error, and `deco schema` writes no schema until you fix it. Then
  route it next to pages:

  ```ts
  const [posts] = await c.list<Post>("post");
  const match = matchRoute(pathname, { routes: [...routes, ...posts] });
  ```

  `client.list(type)` returns entries as saved (nothing run) by default. Pass
  `{ run: true }` to run them.

## Checklist for a new page

1. The path does not shadow another page (`deco check` reports conflicts).
2. Header and footer are references to the shared saved blocks.
3. Each section's type is a key in the block map, and `deco schema` is current.
4. The page has `seo`, or you know which defaults it falls back to.
5. A dynamic page's blocks get the params they need from the page loader.
6. Open the page through `deco push --draft=<name>` and its preview link before
   publishing.
