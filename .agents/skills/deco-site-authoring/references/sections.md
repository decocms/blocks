# Sections

A section is a block function whose return type is a React element or a render
descriptor. `deco schema` reads the block map's default export and puts every key with
such a return type in Studio's section picker. Its first parameter's type becomes the
form.

## Write the component, then register it

1. Write the component in `src/` with a named `Props` interface. Keep it a plain React
   component. It does not know it is a block.
2. Add a key to the block map. The key is the type name content saves in
   `__resolveType`, so pick it once and keep it (kebab-case, like `promo-banner`).
3. Run `deco schema` (or keep `deco schema --watch` running), then place the section on
   a page in Studio or in `.deco/blocks/<Page>.json`.

```ts
// src/model.ts
export interface PromoBannerProps {
  /** @title Text */
  title: string;
  /** @title Link */
  href: string;
}
```

```tsx
// src/PromoBanner.tsx
import type { PromoBannerProps } from "./model";

export default function PromoBanner({ title, href }: PromoBannerProps) {
  return <a href={href}>{title}</a>;
}
```

```json
{ "__resolveType": "promo-banner", "title": "Free shipping over $50", "href": "/shipping" }
```

The JSDoc tags, widgets (`ImageWidget`, `RichText`, `Color` from
`@decocms/compat-v7/types/widgets`), field order and shapes that break the form are in
the `deco-cms-schema` skill. Do not repeat them here.

## Descriptors or elements: follow the binding

What the block function returns depends on how the site renders. Check the existing
block map before you add a key, and do what the other sections do.

| Site | Block function returns | Who renders the component |
|---|---|---|
| TanStack Start (no RSC), as in `examples/tanstack-worker-smoke` | A descriptor: `{ component: "promo-banner", props: input }` | The catch-all route maps `component` to a React component |
| Next.js App Router (`examples/nextjs-binding-smoke`) or TanStack Start with RSC (`examples/tanstack-rsc-smoke`) | An element: `<PromoBanner {...input} />` | The block function, on the server |

Descriptor mode:

```ts
// .deco/index.ts
import type { Blocks, Seo } from "@decocms/blocks";
import type { BlockDescriptor, PromoBannerProps } from "../src/model";

export default {
  seo: (input: Seo) => input,
  "promo-banner": (input: PromoBannerProps): BlockDescriptor => ({
    component: "promo-banner",
    props: input,
  }),
} satisfies Blocks;
```

`BlockDescriptor` is a union the site owns, one member per section:

```ts
export type BlockDescriptor =
  | { component: "promo-banner"; props: PromoBannerProps }
  | { component: "product-hero"; props: ProductHeroProps };
```

Adding a section in descriptor mode takes three edits: the union member, the block map
key, and a `case` in the route's view switch. If you skip the `case`, the section
resolves but renders nothing. Why descriptors: on TanStack Start the page's block
promises go through a server function, so they carry data, not elements.

Element mode:

```tsx
// .deco/index.tsx
export default {
  "promo-banner": (input: PromoBannerProps) => <PromoBanner {...input} />,
} satisfies Blocks;
```

Keep `satisfies Blocks`, not a type annotation. `satisfies` keeps each function's exact
type, and `deco schema` needs it to build the forms and to know which blocks fit which
fields.

## Interactivity: client components, not islands or HTMX

v8 has no islands folder and no HTMX. A section is a normal React tree.

- Put state, effects and event handlers in a small component in its own file, marked
  `"use client"` at the top (like `src/CartButton.tsx` in the examples), and render it
  from the section.
- In element mode the section runs on the server as a Server Component, so hooks in the
  section file itself fail. Only the `"use client"` file hydrates.
- In descriptor mode the whole route tree hydrates. The examples still keep
  `"use client"` on interactive files, so the same component works in both modes.
- Keep the section's props serializable data. Do not pass functions or class instances
  from content into a client component.
- An action that needs the server (add to cart, newsletter signup) is a server function
  on TanStack Start or a server action on Next.js. There is no `/deco/invoke`. See the
  `deco-tanstack-site` and `deco-nextjs-site` skills.

Porting a Fresh section: `class` becomes `className`, `islands/X.tsx` becomes a
`"use client"` component, and each `hx-*` request becomes a server function called from
a client component.

## Sections inside sections

A field typed `ReactNode` or `ReactNode[]` (in element mode) or the site's descriptor
type (in descriptor mode) becomes a section picker in Studio. Use it for layout
sections that hold other sections, like a two-column block. The children resolve before
the parent runs, so the parent gets finished elements or descriptors.

## Data a section needs

A section should not fetch. Give it a prop typed with the data it needs (`product:
Product`) and let the content plug a loader into that prop. A loader block whose
return type fits the prop shows up as a choice in the form. See
[loaders.md](./loaders.md).

If fetching the data is expensive and the section may not need it, type the prop
`Lazy<T>` and call it only when needed. See [lazy-blocks.md](./lazy-blocks.md).

## Things the generator warns about

`deco schema` prints these. Fix them before you push. An error (the last two) means
the schema file is not written at all.

- `"<key>": its props are typed any, so its form is empty`: give the parameter a real
  type.
- `"<key>": returns any, so it isn't offered for any field`: annotate the return type.
- `"<key>" isn't a function`: every block map value must be a function.
- `"<key>": has a "path" field but its type doesn't extend Route`: a `path` field makes
  a block routable. Rename the field, or extend `Route` on purpose (see
  [pages.md](./pages.md)).

## Rendering rules

- **Render nothing for `undefined`.** A section an editor hid with a rule resolves to
  `undefined` and is dropped from the list. The route must not crash on it.
- **Do not mutate what props hold.** The props object itself is a fresh copy, but a
  loader result inside it is shared: the same block with the same inputs runs once per
  request, and every place that uses it gets the same object. Copy before you change it.
- **Keep editable text in props.** A string a merchant would change belongs in the
  Props type, not in the component.
- **Keep layout choices few.** A prop that only picks spacing or color is a design
  token. Use one when editors truly need it, and keep content fields first. The
  `deco-cms-schema` skill covers this.
