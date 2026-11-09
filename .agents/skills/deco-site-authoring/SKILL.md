---
name: deco-site-authoring
description: "Writing sections, pages and loaders for a site on @decocms/blocks 8 (with @decocms/tanstack or @decocms/nextjs). Covers block functions in .deco/index.ts and their Props, React sections as descriptors or elements, client components instead of islands or HTMX, page blocks with path templates and route params, loaders as block functions (one run per distinct input per client, no request object), SEO and JSON-LD fed by the same commerce loader as the page, the built-in lazy block, one promise per section with Suspense and loading skeletons, and the review before deco push. Load it when creating or changing a section, page or loader, when a section never loads, loads twice or shows the wrong data, or before pushing content and code."
---

# Authoring sections, pages and loaders on v8

On @decocms/blocks 8 everything an editor can place is a **block function**: a plain
function in the block map, `.deco/index.ts` (or `.tsx`), that takes one argument, its
inputs, and returns a value. Content is JSON in `.deco/blocks/`, where each object names
a function in `__resolveType` and carries its inputs. `client.resolve` walks that JSON
inside out, so nested blocks run first, siblings run concurrently, and each function
gets its inputs already resolved.

Use this skill when you are writing or changing the code an editor uses. It is not for
wiring the binding or deploying.

## The model in five lines

- **Section**: a block function that returns a React element, or a descriptor
  `{ component, props }`. `deco schema` puts it in the section picker.
- **Loader**: a block function that returns data. A field of type `T` accepts a plain
  value or any block whose awaited return type fits `T`.
- **Matcher**: a block function that returns a boolean.
- **Page**: the built-in `page` block, `{ name, path, seo?, sections }`, routed by
  `matchRoute`.
- **No request scope**: a block function gets its inputs and nothing else. It calls
  `currentClient()` to reach the client, and gets route params as arguments.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/sections.md`](./references/sections.md) | Writing a section, choosing descriptors or elements, adding interactivity (hooks, `"use client"`), porting a Fresh island or an HTMX section |
| [`references/pages.md`](./references/pages.md) | Creating a page block, path templates and params, shared header/footer, a page with variants, routing a custom type, a route conflict |
| [`references/loaders.md`](./references/loaders.md) | Fetching data for a section, passing a route param to a loader, a loader that runs twice, `BLOCK_FAILED`, secrets, upstream fetches |
| [`references/lazy-blocks.md`](./references/lazy-blocks.md) | `Lazy<T>` props, the `lazy` built-in, streaming sections with Suspense, loading skeletons, a failed or hidden section |
| [`references/seo.md`](./references/seo.md) | A page's `seo` field, title and description from product data, canonical and JSON-LD, the SEO checklist for a new site |
| [`references/review-before-publish.md`](./references/review-before-publish.md) | Before `deco push` or opening a PR: the checklist, `deco schema --check`, `deco check` against a draft |

## Rules that hold everywhere

- **One argument, no context.** A block function gets exactly one argument, its
  inputs, with `__resolveType` removed. There is no `req`, no `ctx`, no `invoke`.
- **Results are read-only.** A client runs each block function once per distinct
  input and hands every occurrence the same object. Copy a result before you change
  it.
- **A failing block fails its parent.** The error is `BLOCK_FAILED` with `path`
  set to where it happened, such as `["sections", 2, "product"]`. `resolve` never
  throws: it returns `[value, null]` or `[null, error]`.
- **A hidden block is `undefined`.** A `multivariate` with no true rule resolves to
  `undefined`, and lists drop it. Render nothing for it.
- **Names.** Block map keys are the type names saved in content. Built-in names
  (`lazy`, `multivariate`, `always`, `never`, `experiment`, `campaign`, `page`,
  `redirect`, `redirects`, `cms-settings`, `split-traffic`, `calendar`) are names no
  saved block can take. A block map key with a built-in's name replaces the
  built-in, and `deco check` tells you what relies on it.
- **After changing a Props type, run `deco schema`.** The Studio form comes from
  `.deco/schema.gen.json`, and `deco check` validates against it.

## Related skills

- `deco-site-workflow`: the `deco` CLI end to end (`pull`, `diff`, `push --draft`,
  `publish`, `schema push`, `check`).
- `deco-cms-schema`: how a Props type becomes the Studio form (JSDoc tags, widgets,
  shapes that break the form).
- `deco-tanstack-site` and `deco-nextjs-site`: the catch-all route, `open-page`, the
  worker or proxy, server functions, document head.
- `deco-variants`: `multivariate`, matchers, A/B tests and campaigns.
- `deco-apps`: the `@decocms/apps-*` clients a loader calls, commerce types.
- `deco-images-media`: images and video inside sections.
- `deco-storefront-performance` and `deco-storefront-caching`: slow loaders,
  duplicate upstream calls, payload size, cache keys.
- `deco-v7-to-v8-migration`: a site moving from v7, where sections still use
  `(props, req)` loaders through `@decocms/compat-v7/sections`.
