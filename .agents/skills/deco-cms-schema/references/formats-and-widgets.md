# Formats and widgets

A field's `format` picks its widget in Studio. There are three ways to set it:

1. `@format` on the **field** itself. This always wins.
2. A **widget alias** as the field's type (`image: ImageWidget`).
3. `@format` on a **type alias** the field uses. It applies only when no
   widget alias already set a format.

All three end up as the same `format` string in `.deco/schema.gen.json`.

## Widget aliases

`deco schema` matches these by **name, as written on the prop**
(`WIDGET_TYPE_FORMATS` in `typeToSchema.ts`). Each is a `string`.

| Alias | `format` |
|---|---|
| `ImageWidget` | `image-uri` |
| `VideoWidget` | `video-uri` |
| `HTMLWidget` | `html` |
| `RichText` | `rich-text` |
| `Color` | `color` |
| `TextArea` | `textarea` |
| `Code` | `code` |
| `DateTimeWidget` | `date-time` |
| `Secret` | `password` |

Where to get them:

- `@decocms/compat-v7/types/widgets` (also re-exported from
  `@decocms/compat-v7/types` and `@decocms/compat-v7`) exports `ImageWidget`,
  `VideoWidget`, `HTMLWidget`, `RichText`, `TextArea`, `Color`, `Secret`, plus
  `TextWidget` and `ButtonWidget`.
- `Code` and `DateTimeWidget` are not exported there. Because the match is by
  name, a site can declare `type Code = string` itself and get the widget.
- `TextWidget` and `ButtonWidget` have no format. They are plain text fields.

The alias also works inside the annotation: `ImageWidget[]` sets the format on
the items, and `ImageWidget | null` or an optional field works too. The match is a whole
word, so `BrandColor` does not count as `Color`.

v7 also gave the color widget to any type whose name contained `Color`. v8
does not guess from names. Put `@format color` on the alias or on the field.

`Secret` is a masked text box, nothing more. The value is a plain string saved
in content. Real credentials belong in the deploy platform's secrets, read by
the site's code.

## `@format` on a type alias

`@format` on a type alias reaches every field typed with it, including a
literal select and arrays of it. A field's own `@format` still wins.

```ts
/** @format color */
type TextTone = "black" | "white";

interface Props {
  /** @title Text color */
  tone: TextTone;          // select with format "color"
  /** @title Palette */
  palette: TextTone[];     // items get format "color"
}
```

## `@format` values

The generator passes any `@format` value through unchanged, except `datetime`,
which it rewrites to `date-time` (`FORMAT_ALIASES`).

`deco check` validates only three formats on saved content:

| `@format` | `deco check` accepts |
|---|---|
| `date` | A real calendar date, `YYYY-MM-DD` |
| `date-time` | A date, `T` or a space, and a time; seconds and zone optional |
| `uri` | A parseable URL with a scheme |

Every other format (`image-uri`, `color`, `rich-text`, `textarea`, `html`…)
names a widget, not a rule. `deco check` accepts any string there.

Whether Studio draws a special widget for a format outside the alias table is
Studio's decision, not the generator's. Open the form and look before you rely
on one.

`@format dynamic-options` is kept in the schema, but in v8 it gives a text
field: the site editor never runs site code, so there are no suggestions. See
the `@options` section of [annotations.md](./annotations.md).

## Picking a text widget

- **`RichText`** when the editor needs bold or an inline link. One rich-text
  field beats a text field plus a separate URL field.
- **`TextArea`** for plain running text.
- A bare `string` for one line.
- **`HTMLWidget`** only for markup pasted from elsewhere. It gives the least
  protection against an editor breaking the page.

## Never a bare string where a widget exists

A `videoSrc: string` renders as a text box that asks an editor for a URL. Use
`VideoWidget`. The same goes for images (`ImageWidget`) and colors (`Color`):
no free-text field holding an image URL, no raw hex string without a color
picker.

Name the field for what it holds. Once a field is titled "Video (MP4 URL)",
editors keep pasting URLs even after a picker arrives. Title it "Video
(desktop)" and say in `@description` what an empty value does.

For what an image field's `@description` should say about sizes, see the
`deco-images-media` skill.
