# What each TypeScript shape becomes

`typeToJsonSchema` in `packages/blocks/src/v8/cli/schema/typeToSchema.ts`
turns the props type into JSON Schema; Studio draws the form from that. When a
field comes out as the wrong kind, find its shape here, then read the block's
entry in `.deco/schema.gen.json` to confirm.

## Primitives and selects

| Type | Field |
|---|---|
| `string` | Text (or a widget, see [formats-and-widgets.md](./formats-and-widgets.md)) |
| `number` | Number |
| `boolean`, `true \| false` | Boolean |
| `"a" \| "b"`, a string `enum` | Select: `type: "string"` with `enum`, in the order the type spells them |
| `1 \| 2 \| 3` | Number select |
| A single string literal, `kind: "image"` | `const` with an equal `default`, so new entries get the value |
| `T \| null`, `T \| undefined` | `T` with `nullable: true` |
| `prop?: T` | `T`, left out of `required` |
| `string & { brand }` | The primitive (`string`) |
| `any`, `unknown` | An empty schema: no usable field |

Enum order comes from the declaration, not from the checker, so the select
lists choices as you wrote them.

## Objects, lists and maps

| Type | Field |
|---|---|
| An interface or object type | A group of fields, in declaration order |
| `T[]` | A list of `T` |
| `A & B` (objects) | One group with the fields of both |
| `Record<string, T>` | A map: `additionalProperties` of `T` |
| `Record<string, any>` | A free-form map. It does not offer blocks |
| A type that contains itself (`Link { submenu?: Link[] }`) | A `$ref` to its shared definition |

## Unions of objects: the variant picker

`A | B` where the members are objects becomes `anyOf`: the editor picks one
member and fills in that member's fields. Each member's label comes from, in
order:

1. `@title` on the member's interface or type alias;
2. the type's name (`WideLayout`);
3. the value of the first literal property (`kind: "wide"` → "wide").

An anonymous member with none of these has no label. Give every member a
`@title` in the editor's language: the picker shows those strings.

A union that mixes primitives and objects (`string | Banner`) is also an
`anyOf`, of a text field and a group.

## Sections, lazy values and blocks

| Type | Field |
|---|---|
| `ReactNode`, `ReactElement`, `JSX.Element` | A section picker |
| `ReactNode[]` | A list of sections |
| A render descriptor (`{ component; props }`) | A section picker |
| v7's opaque `Section` / `Section[]` (`type Section = any`) | A section picker / list |
| `Lazy<T>` | A `lazy` block whose `value` has the form of `T` |

An object or list field that a block can fill gets three kinds of choice:
a saved block, "Inline data" (the plain form), and every block whose
function's awaited return type fits the field. "Fits" is TypeScript
assignability, not the type's name. So a `products: Product[]` field offers
every loader that returns `Product[]`. A `Record<string, any>` field does not,
because every block would fit.

How to write lazy blocks and sections is in the `deco-site-authoring` skill.

## Props that never reach the form

These are skipped:

- methods and other function-typed props (but `Lazy<T>` is a field);
- `__resolveType`, any name starting with `$`, and `@type`;
- React internals: `ref`, `then`, `catch`, `finally`, `$$typeof`, `_owner`,
  `_store`;
- symbol keys;
- anything tagged `@ignore`.

Names starting with `_` are kept: `__title` labels a list entry, `_id` is
site data.

Platform types from the TypeScript lib (`URL`, `URLSearchParams`, `Request`,
`Response`, `Headers`, `AbortSignal`, `ReadableStream`, `WritableStream`,
`Blob`, `File`, `FormData`) become a hidden object. Nobody edits them in a
form.

## `required`

A prop that is not optional is in `required`, unless it is hidden with no
default. `deco check` reports saved content missing a required field, and a
`null` where the type is not nullable. If old content may lack the field, make
it optional or give it a `@default`.

## Whole-block warnings

`deco schema` warns, and the form is empty, when:

- the block's props are typed `any`;
- its first parameter is not an object (for example a string).

It also warns when a block returns `any`: that block is then not offered for
any field.
