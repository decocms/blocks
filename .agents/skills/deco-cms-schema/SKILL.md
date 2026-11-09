---
name: deco-cms-schema
description: "@decocms/blocks 8: how a section's Props type becomes the Studio form. Covers what `deco schema` (packages/blocks/src/v8/cli/schema/typeToSchema.ts) reads: the JSDoc tags (@title, @description, @titleBy, @format, @options, @hide, @ignore, @default, validation tags), widget aliases (ImageWidget, RichText, Color, Secret…) and format aliases, what each TypeScript shape turns into (literal unions, object unions, Lazy<T>, ReactNode, block-fillable fields), and declaration order as form order. Also the shapes that hurt editors (sibling anonymous inline types, one-to-many relations linked by a typed key, null holes in arrays, enum plus dead fields instead of a union), blank-on-empty sections, dead fields, and layout controls posing as content. Load it before adding or changing props on a section, loader or page, when a Studio form looks wrong (raw labels, missing widget, select with no options, unlabeled list rows), or when deco check rejects content after a Props change."
---

# Deco CMS schema

A section's `Props` type is the form an editor fills in Studio. A badly shaped
field is not ugly code: it is a person stuck in front of a form that does not
say what it wants.

Load this when you add or change props, when a Studio form looks wrong, or when
`deco check` starts failing after a type change.

## The pipeline

1. `deco schema` reads the default export of `.deco/index.ts` (the block map).
   For each block it takes the first parameter's type and writes one JSON Schema
   per type into `.deco/schema.gen.json`.
2. `deco schema push` uploads that file so Studio can draw forms. Until it runs,
   Studio shows the old form.
3. `deco check` validates every saved block in content against the committed
   `.deco/schema.gen.json`.

Nothing regenerates the schema for you during `vite dev`. Run `deco schema`
after each `Props` change, or keep `deco schema --watch` running. In CI,
`deco schema --check` fails when the committed file is stale. Running these
commands day to day is covered by the `deco-site-workflow` skill.

The generator writes warnings you should not ignore:

- `its props are typed any, so its form is empty`
- `its first parameter isn't an object of props, so its form is empty`
- `returns any, so it isn't offered for any field`

## When to load what

| Reference | Load it when |
|---|---|
| [`references/annotations.md`](./references/annotations.md) | Writing JSDoc on a prop: which tags the generator reads, how values are coerced, `@hide` vs `@ignore`, `@options` lists, `/** */` vs `//` |
| [`references/formats-and-widgets.md`](./references/formats-and-widgets.md) | Picking a widget: image, video, color, rich text, HTML, textarea, date, secret; `@format` on a field or on a type alias; which formats `deco check` validates |
| [`references/types-to-fields.md`](./references/types-to-fields.md) | A field came out as the wrong kind: selects, variant pickers, section pickers, `Lazy<T>`, fields a loader can fill, hidden or missing props |
| [`references/shapes-that-break-the-form.md`](./references/shapes-that-break-the-form.md) | Designing arrays, relations and variants: sibling inline types, keyed relations, null holes, variants as a union |
| [`references/content-hygiene.md`](./references/content-hygiene.md) | Reviewing a section for editors: empty props, dead fields, layout controls, removing or renaming a field that has saved content |

## Two rules that cover most of it

1. **Give every prop a `@title`.** Without one the label is the identifier,
   title-cased: `desktopCardWidth` becomes "Desktop Card Width". That is a
   developer's word, not an editor's.
2. **Declaration order is form order.** Fields come out in the order the type
   declares them. Put what editors touch most at the top: content before
   settings, the heading before the padding.

## Checklist before `deco schema`

- [ ] Every prop has `@title`; `@description` where the field is not obvious,
      written for the editor.
- [ ] Every type used as an array item has `@titleBy <field>`.
- [ ] Image, video, color, rich text, date and secret fields use a widget
      alias or `@format`. No free-text field holding an image URL.
- [ ] `@options` is one JSON array, not one tag per choice.
- [ ] One-to-many relations nest. No two sibling arrays joined by a typed key.
- [ ] No two sibling fields share the same anonymous inline type.
- [ ] Arrays from `Props` are compacted before the first `.map`.
- [ ] The section renders something sensible with empty props.
- [ ] Every field reaches the DOM. No layout controls posing as content.

Then run `deco schema`, read `.deco/schema.gen.json` for the block you changed,
and run `deco check`.

## Related skills

- `deco-site-workflow`: running `deco schema`, `deco schema push`, `deco check`.
- `deco-site-authoring`: writing the section itself.
- `deco-variants`: multivariate blocks inside arrays and fields.
- `deco-images-media`: what an image field's `@description` should say.
- `deco-make-editable`: turning hardcoded content into blocks.
- `deco-v7-to-v8-migration`: form differences between v7 and v8 after a
  migration.
