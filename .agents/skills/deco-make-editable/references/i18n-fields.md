# Two languages: one block, `foo` and `fooPt`

`@decocms/blocks` 8 has no locale concept for content. A site with two
languages decides how content carries both. This is the convention that held
up in a real conversion of a two-language site. Rename `Pt` for your secondary
language.

## The options, and why this one

| Option | Problem |
|---|---|
| One block per language (`Header menu`, `Header menu PT`) | Every change is made twice, and the two drift. The editors who tried it rejected it. |
| Variants that pick a language by path | Every block holds two full copies of its content, and the language rule repeats in every block. |
| An object per field (`title: { en, pt }`) | Form tags that name a string field, such as `@titleBy` for a list item's title, have no flat string to point at. |
| **A sibling field: `title` and `titlePt`** | Fields stay flat. One block, both languages side by side in the form. |

## The convention

- **One block per piece of content, never one per language.**
- Any text field `foo` may have a sibling `fooPt`. Pages in the secondary
  language show `fooPt` when it is filled and fall back to `foo` when it is
  empty.
- **Sections read only `foo`.** One `localize(props, locale)` call, where the
  site renders blocks, picks the language. No section knows about `Pt`.
- **Links are written without the locale prefix.** The component adds `/pt`
  for the secondary language. Editors write `/pricing` once.
- Say it in the form: give each `fooPt` a description such as "Shown on
  Portuguese pages. When empty, the English text is used." (`deco-cms-schema`
  lists the JSDoc tags the form reads.)

```ts
// src/sections/HeaderMenu.tsx
export interface NavigationLink {
  /** @title Label (English) */
  label: string;
  /**
   * @title Label (Português)
   * @description Shown on Portuguese pages. When empty, the English label is used.
   */
  labelPt?: string;
  /**
   * @title Link
   * @description A path such as /pricing. Portuguese pages add /pt automatically.
   */
  href: string;
}

export interface HeaderMenuProps {
  links: NavigationLink[];
}
```

## `localize`

Block results are read-only: a client hands the same object to every place
that uses the same block in a request. `localize` builds a new object and never
changes its input.

```ts
// src/localize.ts
export type Locale = "en" | "pt";
const SUFFIX = "Pt";

/** `fooPt` replaces `foo` on secondary-language pages when filled; `*Pt` keys are dropped. */
export function localize<T>(value: T, locale: Locale): T {
  if (Array.isArray(value)) return value.map((item) => localize(item, locale)) as T;
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    // Drop `fooPt` only when `foo` exists, so a field that is really named `ctaPt` survives.
    if (key.endsWith(SUFFIX) && key.length > SUFFIX.length && key.slice(0, -SUFFIX.length) in source) continue;
    const translated = source[`${key}${SUFFIX}`];
    const useTranslation = locale === "pt" && typeof translated === "string" && translated.trim() !== "";
    result[key] = useTranslation ? translated : localize(child, locale);
  }
  return result as T;
}
```

Write a unit test for it: a nested list, an empty `fooPt`, a field genuinely
named `somethingPt` without a `something`.

## Where the language comes from

A block function receives only its saved input, so the language is never
decided inside the block map. The site decides it from the request (the path
prefix, usually) and applies `localize` where it renders:

- **Descriptors:** the code that maps `{ component, props }` to a component
  calls `localize(props, locale)` and passes `locale` as an extra prop, outside
  the `Props` type, so it never appears in the form.
- **JSX blocks:** the component reads the language from the site's own React
  context and calls `localize` on its props.

## Routing the secondary language

Both languages render the **same** page block. The secondary-language route
removes its prefix before matching, so `/pt/pricing` finds the page whose
`path` is `/pricing`, and only `locale` changes:

```ts
const locale: Locale = href === "/pt" || href.startsWith("/pt/") ? "pt" : "en";
const path = locale === "pt" ? href.slice(3) || "/" : href;
const match = matchRoute(path, { routes });
```

## Automatic translation

Filling `fooPt` with an LLM (for example a CI job on the content change) is
possible. It needs an API key and a human review step. Start with manual
fields; add translation only when the team asks for it.
