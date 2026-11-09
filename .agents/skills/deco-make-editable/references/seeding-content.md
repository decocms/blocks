# Seeding content from the current code

Never retype content. Extract it from the code that ships today. Byte-identical
content is what makes the [pixel comparison](./pixel-parity.md) mean
something: if a single apostrophe changed, you cannot tell a typo from a
regression.

## Extract with a throwaway script

Most hardcoded content is already data: a `COPY` object, a `LINKS` array. Load
it in isolation and write the block JSON from it.

```ts
// scripts/seed-header.ts (run once with `bun scripts/seed-header.ts`, then delete)
import fs from "node:fs";
import { LINKS } from "../src/components/Header.constants";

const block = {
  __resolveType: "header-menu",
  links: LINKS.map(({ label, labelPt, href }) => ({ label, labelPt, href })),
};
const name = "Header menu";
fs.writeFileSync(`.deco/blocks/${encodeURIComponent(name)}.json`, `${JSON.stringify(block, null, 2)}\n`);
```

- If the constant lives in a component file that imports React or CSS, move it
  to its own module first (the component then imports it). That is a
  refactor with no visual change; commit it separately.
- Component references in the data (`icon: RocketIcon`) cannot go into JSON.
  Replace them with string keys and keep a closed list in code:
  `const ICONS = { rocket: RocketIcon, book: BookIcon }`, with
  `icon: keyof typeof ICONS` in `Props`. Editors then pick from a list instead
  of typing a free-text name. `deco-cms-schema` shows how the form renders it.
- Text written straight in JSX has no constant to load. Copy it with the
  script anyway (read the file, cut the strings), or paste it once and check
  the [HTML diff](./pixel-parity.md#html-parity) shows no change.
- Once the block exists, delete the constant. Keeping it "as a fallback"
  creates a second source of truth.

The file name is `encodeURIComponent(name)` plus `.json`, directly in
`.deco/blocks` (subfolders are not read).

## Content in git (no `site`)

A site created with `createCMS({ blocks, content })` and no `site` reads the
content module, `.deco/blocks.gen.ts`, bundled with the build.

```sh
deco schema              # .deco/index.ts → .deco/schema.gen.json
deco content             # .deco/blocks → .deco/blocks.gen.ts
deco check               # every saved block against the schema
```

During `vite dev`, `deco content --watch` rewrites the module on each save,
and the `decoContent()` plugin (included in `decoTanstack()`) swaps the new
content into the running CMS and reloads open pages. Edit a block file, and
the page shows it.

## A hosted site (`site` set)

A site created with `createCMS({ blocks, site })` reads its content from the
delivery CDN at runtime. The CLI finds the same site in `DECO_SITE` (the
environment, `.env`, `.dev.vars` or `vars` in the wrangler config). The local
`.deco/blocks` is what `deco pull` wrote, and changes travel as drafts:

```sh
deco pull                          # production into .deco/blocks
# write or edit the seeded files
deco diff                          # what changed since the pull
deco push --draft=header-menu      # one save into the draft (creates it); prints its preview link
deco check --draft=header-menu     # the draft against the local .deco/schema.gen.json
deco drafts url header-menu        # the preview link again
```

- `deco push` sends only the blocks changed since the pull. Deletes are sent
  only with `--prune`.
- One push is one save, at most 500 blocks and 8 MiB. A larger push fails with
  "don't fit one save": push fewer blocks at a time.
- `deco check --draft` validates the draft against the schema on disk, so it
  checks the branch's new types before anything is deployed.
- Open the preview link on a local dev server of the branch to see the seeded
  content with the new code. If the link renders the release instead of the
  draft, the host is not allowed to preview: see "Draft hosts" in the
  `@decocms/tanstack` README, and `deco-site-workflow`.

The full set of content commands (`drafts`, `publish`, `releases`, rollback)
is in `deco-site-workflow`.

## Order of publish and deploy

On a hosted site, content and code ship separately. Pick the order so that the
live site never runs code that reads a block that is not published yet:

1. Publish the draft with the **new** blocks first. Old code never reads them,
   so this changes nothing on the live site.
2. Deploy the code that reads them. The production deploy should also run
   `deco schema push` (see `deco-site-workflow`): that is what gives Studio
   the forms for the new types.
3. Only then publish changes to **existing** blocks that the old code would
   not understand, such as a page whose sections now use a new section type.

Do not run `deco publish` without the site owner's explicit OK for that
publish.

## What `deco check` covers

`deco check` validates each saved block against the generated schema:

- required fields that are missing, unknown fields, wrong types, values
  outside an `@options` list;
- a `__resolveType` that names no block type, built-in or saved block;
- a block placed in a field it does not fit;
- page paths that conflict, and redirect rules outside the redirects block.

It does not check that an internal link (`href: "/pricing"`) points at a page
that exists, and an empty string passes a required string field. If either
matters for your site, add a small script to CI that walks `.deco/blocks` for
link fields and compares them with the page paths and the site's own routes.
