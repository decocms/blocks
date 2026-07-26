# The `.deco` filesystem contract (FS-based Studio hand-off)

> Audience: whoever builds the **FS-based Studio** — the mode where Studio reads
> a site's `.deco/` directly off the filesystem (via a workspace-mounting
> daemon) instead of calling a running site's HTTP admin protocol.
>
> This is the contract between the **producer** (`@decocms/blocks-cli` /
> `@decocms/eitri`, which write `.deco/`) and the **consumer** (Studio, which
> reads/writes it). It is stack-agnostic; the **Eitri** stack is the first
> consumer that has *no* running deco server, so it is what motivates this doc.
> Companion: [`eitri-stack-design.md`](./eitri-stack-design.md).

## TL;DR for the Studio side

To edit a site, Studio needs exactly two things from `.deco/`:

1. **`.deco/meta.gen.json`** — the block **types** (JSON Schema) → drives the
   catalog + config forms. For FS mode it is generated **self-contained**
   (`generate --platform eitri`, or `generate-schema --compose`), so **read it
   verbatim — do NOT run `composeMeta` again** (it's already baked in;
   re-composing would duplicate Page/matchers/Resolvable).
2. **`.deco/blocks/`** — the **content**: one JSON file per block instance.
   Read to populate the editor; write here to persist edits.

Everything else in `.deco/` is either a derived convenience (`blocks.gen.json`)
or stack-specific runtime glue Studio should ignore (see
[Ignore list](#what-studio-should-ignore)).

## Where `.deco/` lives

At the app root. For the reference app it is
`montecarlo-app/eitri-shopping-monte-carlo-shared/.deco/`. The daemon mounts the
workspace; the app root is the directory containing `.deco/` (and, for Eitri,
`eitri-app.conf.js` + `src/sections/`).

## 1. Schema — `.deco/meta.gen.json`

This is the full `/deco/meta` `MetaResponse` payload, materialized to a file.
Top-level shape:

```jsonc
{
  "major": 1,
  "version": "1.0.0",
  "namespace": "site",
  "site": "montecarlo",
  "framework": "eitri",          // "tanstack-start" for React stacks
  "platform": "eitri",
  "cloudProvider": "eitri",
  "manifest": { "blocks": { "sections": {…}, "loaders": {…}, "actions": {…},
                            "pages": {…}, "matchers": {…}, "apps": {…} } },
  "schema": { "definitions": {…}, "root": {…} }
}
```

- **`manifest.blocks.<category>`** — the catalog of available block **types**:
  `{ "<blockKey>": { "$ref": "#/definitions/<b64(blockKey)>", "namespace": "…" } }`.
  Categories: `sections`, `loaders`, `actions`, `pages`, `matchers`, `apps`.
- **`schema.definitions`** — JSON-Schema-7 definitions. Keys are
  **`base64(blockKey)`**. Section blocks also emit a sibling props definition
  keyed `<opaqueId>@Props` and reference it via `allOf`. Well-known literal
  keys also present: **`Resolvable`** ("select from a saved block") and
  **`__SECTION_REF__`** (the section picker).
- **`schema.root.<category>.anyOf`** — the **picker lists**: which block types
  are selectable in each category (this is what a "pick a section" dropdown
  reads).

A single block definition looks like:

```jsonc
// definitions["<b64('site/sections/Banners/Hero.tsx')>"]
{
  "title": "site/sections/Banners/Hero.tsx",
  "type": "object",
  "allOf": [{ "$ref": "#/definitions/<id>@Props" }],   // the props form
  "required": ["__resolveType"],
  "properties": {
    "__resolveType": { "type": "string", "enum": ["site/sections/Banners/Hero.tsx"],
                       "default": "site/sections/Banners/Hero.tsx" }
  }
}
```

Property schemas carry the form hints: `title`, `description`, `nullable`,
`default`, `enum`, and a `format` widget (`image-uri`, `video-uri`, `html`,
`rich-text`, `color`, `password`, `textarea`, `code`, `date-time`). A `Section`
/ `Section[]` prop becomes a `$ref` to `__SECTION_REF__`; a loader-typed prop
becomes `anyOf: [Resolvable, …matching loaders]`.

**Rendering note:** Studio renders the **config form** from these schemas. It
does **not** render the section visually — there is no deco renderer for Eitri
(Eitri renders natively on-device). Visual preview is out of scope here.

## 2. Content — `.deco/blocks/` (the decofile)

One JSON file per block **instance** = its configured props plus a
`__resolveType` naming its type:

```jsonc
// .deco/blocks/Category%20Banner%20-%2001.json
{ "banners": [ /* … */ ], "__resolveType": "site/sections/Category/CategoryBanner.tsx" }
```

A **page** is a block whose `sections` is an ordered list of instances (inline
props) and/or references to saved blocks:

```jsonc
// .deco/blocks/pages-Home.json
{
  "name": "Home Page",
  "path": "/",
  "sections": [
    { "__resolveType": "site/sections/Banners/Hero.tsx", "image": "…" },
    { "__resolveType": "Header" }                          // reference to a saved block
  ]
}
```

### Filename ↔ key encoding (must round-trip)

The filename (minus `.json`) is **`encodeURIComponent(blockKey)`**; decode with
a **single** `decodeURIComponent`. This matches the runtime's `parseBlockId`, so
`Studio.write(encodeURIComponent(key))` round-trips to the exact file the
generator reads. (The generator tolerates a legacy double-encoded form on read,
but **always write single-encoded.**)

### Fresh app

A brand-new app has **no `.deco/blocks/` directory yet** (no content authored).
Treat "missing dir" as "empty decofile", not an error. Studio creating the first
block creates the directory.

## 3. Writing content back (Studio → disk)

On create/edit: write `.deco/blocks/<encodeURIComponent(key)>.json` with the
instance JSON. On delete: remove the file. The daemon syncs these to disk. The
bundled snapshot (`blocks.gen.json`, below) is **derived** — regenerate it after
writes (run `deco-eitri generate`, or have the daemon re-run the `blocks`
generator / apply a delta, exactly as the TanStack Vite plugin's
`readBlockDelta` does).

## 4. Derived snapshot — `.deco/blocks.gen.json`

A single file merging every `.deco/blocks/*.json` into
`{ "<blockKey>": <instance> }`. It is what the **Eitri runtime** fetches
on-device (one file, fast JSON parse) — Studio can ignore it for editing (read
the `blocks/` dir, which is the source of truth) but must keep it in sync (or
let the daemon/generator do so) since the device consumes it. `{}` for a fresh
app.

## 5. Regeneration triggers (daemon responsibilities)

- **Section source changes** (`src/sections/**`, `tsconfig.json`) → re-run
  `deco-eitri generate` (schema) so `meta.gen.json` reflects new/edited section
  Props. (Mirror the TanStack Vite plugin, which watches `src/**` and re-runs
  `generate-schema`.)
- **`.deco/blocks/**` changes** (Studio writes) → refresh `blocks.gen.json`.
- `.deco/generate.digests.json` is the committed incremental cache — safe to
  leave alone; `generate` maintains it.

## What Studio should ignore

Produced by other stacks' runtimes, **not** part of the FS contract and **not**
emitted for Eitri: `sections.gen.ts`, `blocksManifest.gen.ts`, `loaders.gen.ts`,
`invoke.gen.ts`, and the `blocks.gen.ts` Vite load-stub. There are also **no**
`/deco/render` or `/deco/invoke` endpoints for Eitri (no running server).

## Identifying the app

`meta.gen.json` carries `framework` (`"eitri"`), `namespace`, and `site`. Eitri
app identity (for linking to the Eitri workspace / publishing) lives in
`eitri-app.conf.js` (`applicationId`, `organizationId`, `slug`) — relevant to
delivery, not to the schema/content contract.

## Open items to confirm with the producer side

1. **Delivery mechanism.** How the workspace `.deco/` reaches Studio — a daemon
   that mounts it (reuse `packages/tanstack/src/daemon/` pattern, or a thin
   Eitri daemon?). Decide shared vs. per-stack. *(Phase 3.)*
2. **Write-back ownership.** Confirm Studio writes `.deco/blocks/*.json`
   directly (single-encoded filenames) and the daemon owns `blocks.gen.json`
   refresh — vs. Studio calling a generator hook.
3. **On-device consumption** (downstream, Eitri/client-owned): the Eitri runtime
   fetches `blocks.gen.json` (or a per-page decofile) and maps `__resolveType` →
   its local section module. Not Studio's concern, but the delivery format must
   match what the device expects.
