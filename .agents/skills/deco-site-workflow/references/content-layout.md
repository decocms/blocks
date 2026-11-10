# Where content lives

## The `.deco/` folder

Every `deco` command finds the folder that contains `.deco/` by walking up from the current folder,
or takes `--root <dir>`. That folder is the **root**: the CLI also reads `.env`, `.dev.vars` and
`wrangler.*` there.

| Path | Written by | In git? | What it is |
|---|---|---|---|
| `.deco/index.ts` (or `.tsx`) | you | yes | The block map: `export default { hero, … } satisfies Blocks`. Each key is a block type. |
| `.deco/schema.gen.json` | `deco schema` | yes | Forms and validation, from the block map's types. Declares `"blocksMajor": 8`. |
| `.deco/blocks/*.json` | `deco pull`, you | hosted site: no. Bundled site: yes | Saved blocks, one file per block. |
| `.deco/pull.json` | `deco pull`, `deco push` | no | What was pulled: per block, its hash and the draft precondition. The base of `deco diff` and `deco push`. |
| `.deco/blocks.gen.ts` | `deco content` | no (generate it in `predev`/`prebuild`) | The content module, only for content without a site. |

A **hosted** site (`createCMS({ blocks, site })`) reads content from the CDN, so `.deco/blocks` is a
working copy that `deco pull` fills. A **bundled** site (`createCMS({ blocks, content })`, as in the
repo's examples and in a site still moving off v7) commits `.deco/blocks`, turns it into
`.deco/blocks.gen.ts` with `deco content`, and needs a deploy for every content change. Moving from
bundled to hosted: [serve-and-studio.md](./serve-and-studio.md), Steps 1 and 3.

## Block names and files

A saved block's **name** is its file name, decoded: `encodeURIComponent(name) + ".json"`, directly in
`.deco/blocks/`. Studio, the CLI and the runtime share this one rule (`@decocms/blocks/protocol/keys`).

- No subfolders. A file in a subfolder is reported: `subfolders of .deco/blocks aren't read`.
- The file holds one JSON object, written as `JSON.stringify(block, null, 2)` plus a newline.
- A name can't be empty, contain `..`, a backslash or NUL, start with `.`, be `__proto__`, be a
  Windows device name (`con`, `nul`, `com1`…), end in a source extension (`.ts`, `.tsx`, `.js`…), or
  encode to more than 250 bytes.
- Two files that decode to the same name: one wins (the one with a `path`, then the one that took
  more decoding, then the lowest file name). The others are reported as
  `another spelling of "<name>"; <file> wins`. Delete the losers.
- A name of a built-in block (below) can't be a saved block.

## Inside a block

Every block is an object with `__resolveType`. The rest are its props.

```json
{
  "__resolveType": "page",
  "name": "About",
  "path": "/about",
  "sections": [
    { "__resolveType": "Header" },
    { "__resolveType": "hero", "title": "Who we are" },
    { "__resolveType": "Footer" }
  ]
}
```

`__resolveType` is one of:

- **a block type**: a key of the block map (`hero`);
- **a built-in**: `lazy`, `multivariate`, `always`, `never`, `experiment`, `campaign`, `page`,
  `redirect`, `redirects`, `cms-settings`, `split-traffic`, `calendar`;
- **a legacy alias**: a v7 type name the runtime maps to a v8 one (see `deco-v7-to-v8-migration`);
- **a saved block's name**: a **reference**. `{ "__resolveType": "Header" }` uses the saved block
  `Header`. This is how a header or footer is shared by every page: change the saved block once.

`deco check` reports a `__resolveType` that is none of these as `no saved block or block type "<name>"`.
This is usually a deleted block that something still references.

### References Studio can edit

The runtime resolves more shapes than Studio's editor can open. `deco check` rejects these as errors,
so content that passes it opens in Studio:

- **A saved block typed as another saved block.** `Footer-Island` =
  `{ "__resolveType": "Footer", "revealOnScroll": true }` renders (the resolver follows the chain and
  merges each hop's props), but Studio's editor follows one hop, finds no form for `Footer` and shows
  an empty one. A bare alias (`{ "__resolveType": "Footer" }` saved under another name) is the same.
  Type the block by its section or loader (`site/sections/Footer.tsx`) and copy in the props it took
  from `Footer`; the error names the chain and those props.
- **A reference with props of its own.** A page section
  `{ "__resolveType": "Footer", "hasFixedNewsletter": true }` renders with the props merged over
  `Footer`'s, but Studio shows and edits `Footer` itself: it ignores these props and saves every edit
  to `Footer`, for every page that uses it. The merge is shallow, so even `"seo": {}` replaces the
  saved `seo`. Keep the reference bare, or inline it: type it by the section
  (`site/sections/Footer.tsx`) and copy in `Footer`'s props it doesn't set; the error lists them.
- **A reference to a saved block whose name ends in `.` and letters or digits** (`Promo 2.0`,
  `Banner.v2`). Studio reads such a name as a module path (like `site/sections/Footer.tsx`), finds
  no form for it and shows an empty one. Rename the block and its references. Studio never reads
  `constructor` or `__proto__` as a saved block's name either.

A bare reference (`{ "__resolveType": "Footer" }`, nothing else) is fine anywhere: in a page's
sections, a variant, a lazy block or a prop.

## Blocks with a fixed role

| Saved block | Type | Role |
|---|---|---|
| any name, with `path` | `page` | A routed page: `name`, `path`, `sections`, optional `seo` |
| `Redirects` (by convention) | `redirects` | The site's one list of redirect rules. Only one `redirects` block is routed: the first by name |
| `CMS` | `cms-settings` | CMS settings (telemetry, analytics). Studio edits it. Its body is inline in the release index |
| `experiments` | `split-traffic` | A/B tests. Every `experiment` rule reads it |
| `campaigns` | `calendar` | Scheduled campaigns. Every `campaign` rule reads it |

Variants (`multivariate`), rules, tests and campaigns are the `deco-variants` skill. `lazy` and
`Lazy<T>` fields are in `deco-site-authoring`. Two page paths, or two redirect `from`s, that match the
same URLs are a `deco check` error.

## On the CDN

What `deco publish` creates, under `https://delivery.decocms.com/sites/<site>/`:

- `blocks/<hash>.json`: a block body, stored once by content hash and never changed.
- `revisions/<id>/index.json`: a release. It maps each name to its hash, plus `type`, `path` and
  `refs` (the names it references), so routing and the reference walk need no body.
- `latest.json`: a copy of the current release's index, plus `previewHosts`.
- `drafts/<slug>/…`: a draft's `index.json` (the names it holds) and one file per changed block.

Revision ids look like `<12 hex>-<uuidv7>`. `deco releases` lists them. How the site reads all this:
[delivery.md](./delivery.md).
