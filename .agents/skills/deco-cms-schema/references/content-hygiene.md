# Content hygiene: fields that should not exist

A form is easier to use with fewer, better fields. This file covers what to
render when fields are empty, which fields to remove, and how to remove one
without breaking saved content.

## Render something sensible with empty props

A new block starts with nothing filled in, and an optional prop arrives as
`undefined`. The section must not throw and should not render blank: a
realistic default is how an editor learns what a field is for.

Declare `DEFAULT_*` constants for what optional fields fall back to, and use
them once, where props enter the component, instead of scattering
`?? something` through the JSX.

```tsx
const DEFAULT_TITLE = "New arrivals";

export function Shelf({ title = DEFAULT_TITLE, products = [] }: Props) {
  // …
}
```

`@default` only writes `default` into the schema. It does not change what
your component receives for content saved without the field, so keep the code
default too.

## Dead fields: the editor sets them, nothing happens

A field that reaches no DOM attribute is worse than a missing one. The editor
changes it, sees no effect, and decides the CMS is broken.

They pile up when a shared type is reused for a narrower purpose: a `Cta` type
with `buttonStyle`, `backgroundColor`, `hoverColor` and `showArrowIcon`,
attached to a section that only reads `url` and `text`. Give that section its
own narrower type.

Check the result in `.deco/schema.gen.json`, not in the `.tsx` diff: every
removed field gone from the block's definition, every kept field still there.

## Layout controls posing as content

A field should carry an editorial decision: which image, which text, which
color, how many items. Not a layout one: card width in pixels, a desktop gap
and a separate mobile gap as raw numbers.

The test: remove the field and fix one value in the component. Does the
editor lose a decision they really need to make? If not, it is not a prop.
One content review removed a set of these because every editor used the same
value anyway. The fields only added a way to break the layout by accident.

When a developer escape hatch has to stay visible, end its `@title` with
"(advanced)" so editors can tell it from fields meant for daily use.

## Removing or renaming a field with saved content

`deco check` rejects a key that the code does not declare. Keys starting with
`_`, `$` or `@` are exempt. So deleting or renaming a prop makes every saved
block that still has the old key fail `deco check`.

Two safe paths:

- **Migrate the content in the same change.** Update the saved blocks so no
  value uses the old key, run `deco check`, and ship both together. How to
  edit content and send it as a draft is in the `deco-site-workflow` skill.
- **Retire the field first.** Keep it in the type with `@hide` and
  `@deprecated`, with a `//` comment saying what replaced it. Content keeps
  validating; editors no longer see it. Delete it once no content uses it.

`@ignore` is not a way to retire a field: it removes the field from the
schema, so saved values fail `deco check` just as if it were deleted.

## Placeholder content

Blocks left with lorem ipsum, placeholder image URLs, or hidden on the page
render nothing useful and clutter the form with entries an editor cannot tell
from real ones. Delete them before handing the site over.

## Structure

- Past about 30–40 lines of `Props`, or once there are two or more nested
  types (an array item, a variant union), move the types to a sibling
  `types.ts`. Types only, no logic.
- More than about eight top-level fields with no grouping reads as a wall of
  inputs. Group them into named nested objects (`/** @title Colors */ colors:
  {…}`).
- When two or more sections need the same piece of form (same field, same
  label, same `@description`), extract a shared type and compose it. Image
  pairs (desktop and mobile) and autoplay settings are the usual candidates.
  Sections that should behave the same drift apart otherwise.
