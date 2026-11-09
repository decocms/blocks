# Annotations `deco schema` reads

The generator is `packages/blocks/src/v8/cli/schema/typeToSchema.ts`
(`getJsDocTags` and `applyJsDocToSchema`). It was ported from v7's generator,
so most tags behave as they did. The differences are called out below.

## Only `/** */` reaches the schema

The generator reads JSDoc blocks. A `//` comment never reaches the form. Use
the split on purpose:

- `/** @title … @description … */` is for whoever fills the form.
- `// comment` is for whoever reads the code: measurements, the reason behind
  a value, links to tickets.

One section shipped a `@description` with twenty lines of typography
measurements and production URLs. The editor opened the form and got a spec
sheet where the help text should be.

The free text at the top of a JSDoc block becomes `description`. An explicit
`@description` tag replaces it.

A tag followed directly by punctuation (`@description: text`) is skipped. Write
`@description text`.

## Tag table

| Tag | What lands in the schema |
|---|---|
| `@title` | `title`, the field label. Without it: the prop name title-cased (`marginTop` → "Margin Top") |
| `@description` | `description`, help text |
| `@titleBy <field>` | Passed through. On an array item's type, names the field that labels each row |
| `@format <name>` | `format`, the widget. `datetime` is rewritten to `date-time`. See [formats-and-widgets.md](./formats-and-widgets.md) |
| `@default <value>` | `default`, coerced (below) |
| `@options <JSON array>` | `enum` (and `enumNames` when items have labels). Anything else is dropped (below) |
| `@hide` | `hide: "true"`. The field stays in the schema and in content, hidden from the form |
| `@ignore` | The prop is left out of the schema |
| `@examples` | `examples`: one per line, or a JSON value |
| `@minimum` `@maximum` `@exclusiveMinimum` `@exclusiveMaximum` `@multipleOf` | Numbers |
| `@minLength` `@maxLength` | Numbers |
| `@minItems` `@maxItems` `@minProperties` `@maxProperties` | Numbers |
| `@readOnly` `@writeOnly` `@deprecated` `@uniqueItems` | Booleans |
| Any other tag (`@pattern`, `@placeholder`, `@widget`, `@icon`, `@mode`…) | Passed through as a string. The generator gives it no meaning; whether Studio does is Studio's call |

`deco check` validates content with Ajv against the generated schema, so the
standard JSON Schema keywords above (`minimum`, `maxLength`, `pattern`,
`minItems`…) are enforced on saved content too, not only in the form.

## Coercion

- **Numeric tags** become `Number(value)`. Always give a value: a bare
  `@minimum` is `Number("true")`, which is `NaN`.
- **Boolean tags** are `true` when the value is `true` or missing. A bare
  `@deprecated` or `@uniqueItems` works. Anything else, including `yes`, is
  `false`.
- **`@default`**: `true`, `false` and `null` become those values; a numeric
  string becomes a number; otherwise it is parsed as JSON, and if that fails it
  is kept as the raw string. `@default hello` is `"hello"`;
  `@default ["a","b"]` is an array.
- **`@hide`** sets `hide: "true"` whatever value follows it.

## `@titleBy`: make array rows readable

Put `@titleBy` on every type used as an array item. Without it Studio has no
field to label rows with, and the editor opens each row to find out what it
is.

```ts
/** @titleBy label */
export interface FooterLink {
  /** @title Label */
  label: string;
  /** @title URL */
  href: string;
}
```

## `@options`: one JSON array

A static list must be one JSON array in one tag:

```ts
/**
 * @title Align
 * @options ["left", "center", "right"]
 */
align: string;

/**
 * @title Level
 * @options [{ "value": "advanced", "label": "Advanced" }, { "value": "basic", "label": "Basic" }]
 */
level: string;
```

Items are strings, numbers or `{ value, label }` objects. Labels go to
`enumNames`.

What does not work in v8:

- **One `@options` tag per choice.** The generator keeps one value per tag
  name, so only the last line survives. A single object is not an array, so it
  is dropped and the field is plain text.
- **A loader path** (`@options site/loaders/x.ts`, often with
  `@format dynamic-options`). v7 called the loader while the editor typed. The
  v8 site editor never runs site code, so the list is dropped and the field is
  a text field. Make sure the field still accepts what an editor would type,
  and rewrite any `@description` that promises suggestions.

A string-literal union needs no `@options`: `align: "left" | "center"` is
already a select. See [types-to-fields.md](./types-to-fields.md).

## `@hide` vs `@ignore`

- `@ignore` removes the prop from the schema. Studio does not know it exists.
  Saved content that still has the key fails `deco check` (a field the code
  does not declare).
- `@hide` keeps the field in the schema and in content, and hides it in the
  form. Use it for a value another tool or old content still sets, or a field
  you are retiring (see [content-hygiene.md](./content-hygiene.md)).

A hidden prop that is not optional is not marked `required`, since no editor
can fill it, unless it has a `@default` (or a literal type, which gets a
default).

Leave a `//` comment that says why a field is hidden or ignored. Otherwise the
next person sees a prop that is mysteriously missing from the form.

## Tags on a type, not a field

JSDoc on an interface or type alias applies to the object schema built from
it. This is how a union member gets its name in a variant picker:

```ts
/** @title Wide */
export interface WideLayout { /** @title Aspect ratio */ aspectRatio: string }
```

`@format` on a type alias reaches every field of that type. See
[formats-and-widgets.md](./formats-and-widgets.md).
