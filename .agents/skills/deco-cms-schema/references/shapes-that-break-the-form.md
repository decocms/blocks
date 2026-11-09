# Shapes that break the form

These shapes compile, pass review and generate a schema. They fail in front
of an editor, or in production on content an editor saved.

## Nest a one-to-many relation. Never link it by a typed key.

If an item belongs to exactly one group, the items live inside the group.

```ts
// Good: a column owns its links
/** @titleBy heading */
export interface FooterColumn {
  /** @title Heading */
  heading: string;
  /** @title Links */
  links: FooterLink[];
}

// Bad: two sibling arrays joined by a key the editor types from memory
tabs: { label: string; key: string }[];
cards: { caption: string; tabKey?: string }[];
```

The bad shape fails three ways. The typed key has no autocomplete. A
mismatched key makes a card vanish from its tab with no visible error. And the
two arrays have to be kept in sync by hand. Use sibling arrays plus a key only
when the relation is really many-to-many, which is rare in editorial content.

## Two sibling fields with the same anonymous inline type

```ts
// Bad
collection?:  { collectionId: string } | { skuId: string };
collection2?: { collectionId: string } | { skuId: string };
```

Both fields produce identical inline schemas (the generator gives a shared
`$ref` only to named types). On the v7 Studio this shape made both fields
share one form state: typing into the first mirrored into the second, and it
shipped on live content. That bug has not been checked on the v8 Studio.

Either way, numbered sibling slots are the wrong shape. Use a list, so each
entry is its own node:

```ts
/** @titleBy label */
export interface Companion {
  /** @title Label */
  label: string;
  /** @title Collection ID */
  collectionId?: string;
}

interface Props {
  /** @title Companion products */
  products?: Companion[];
}
```

If saved content still uses the old fields, keep them with `@hide @deprecated`
until the content is migrated. See [content-hygiene.md](./content-hygiene.md).

## Arrays from content can hold holes

The type says `T[]`. At runtime an entry can still be:

- `null`, saved in content, or returned by a block in that slot;
- an object with fields missing: an empty row an editor saved, or content
  written before a field was added.

What changed in v8: when a block inside an array resolves to `undefined` (for
example a `multivariate` with no matching rule), the resolver drops that entry
and the array gets shorter. v7 left a `null` in the slot. `null` values are
still kept.

`deco check` reports a `null` where the item type is not nullable, and missing
required fields. Run it, but do not count on it: content changes after deploy.

Compact once, where the data enters the component, before any `.map`,
`.filter` or `.find`:

```ts
const isPresent = <T>(value: T | null | undefined): value is T => value != null;
const links = (props.links ?? []).filter(isPresent);
```

Prefer a type guard like this over `.filter(Boolean)`. `Boolean` works at
runtime but does not narrow the type, so you cast afterwards. On a list of
primitives it also drops legitimate `0`, `""` and `false`.

This matters most in a section on every page (header, footer). One unhandled
hole there breaks every page, not one section.

How multivariate blocks are written and previewed is in the `deco-variants`
skill.

## Variants: a union of types, not an enum plus dead fields

When a field can take really different structures, model it as a union of
named types, each with a `@title`. The editor picks a member and sees only
its fields, instead of an `aspectRatio` box that does nothing under every
other choice. See [types-to-fields.md](./types-to-fields.md) for how members
get their labels.

```ts
/** @title Wide */
export interface WideLayout {
  /** @hide */
  kind: "wide";
  /** @title Aspect ratio */
  aspectRatio: string;
}

/** @title Contained */
export interface ContainedLayout {
  // Nothing to set: this is the default crop. The literal keeps the type
  // from being empty (see below).
  /** @hide */
  kind: "contained";
}

interface Props {
  /** @title Layout */
  layout?: WideLayout | ContainedLayout;
}
```

Details that keep this safe on a section that already has content:

- **Do not leave a member empty.** In v8 an object field also offers every
  block whose return type fits it (TypeScript assignability, see
  [types-to-fields.md](./types-to-fields.md)). An empty interface accepts any
  object, so every block that returns an object would show up as a choice.
  A single string literal field fixes it. The generator gives a literal an
  equal `default`, so the editor writes it into new entries, and a hidden
  field with a default stays required.
- **Switch on the literal** at runtime (`layout?.kind === "wide"`), and treat
  any other value as the default member.
- **Adding `kind` to a union that already has content** makes old entries
  fail `deco check` (a required field is missing) until each saved value gets
  its `kind`. Run `deco check` and fix the content in the same change.
- **Keep the prop optional.** Content saved before the union existed has no
  value, and `deco check` would report a missing required field.
- **Title every member** in the editor's language.

When each member of a string union needs a matching value, pair it with a
`Record<Union, …>`. The compiler then refuses a new option without its
counterpart.

```ts
type Tone = "light" | "dark";
const TONE_CLASS: Record<Tone, string> = { light: "bg-white", dark: "bg-black" };
```

## Free text is untrusted input

A text field is the one place TypeScript cannot help: the editor can type
anything. If the code parses it (a number, a JSON value, a facet key, a URL),
guard the parse at the consumer and fall back to a default. On a section
that renders on every page or on the home page, a bad value breaks the whole
page. One incident came from an editor typing a platform-specific facet key
into a free-text field.

If the value has a closed set of choices, make it a select instead
(a literal union or `@options`).
