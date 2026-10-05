# Apps that render content natively

Some v7 projects aren't websites. They're native or mobile apps (a v7 binding such as `@decocms/eitri`) that bundle `.deco/blocks/*.json` at build time and render sections through their own component table. For these apps, the v7 package only generated Studio's files (`.deco/meta.gen.json`, `.deco/blocks.gen.json`). No runtime file imports a `@decocms/*` package.

v8 has no binding for them, and needs none. The app keeps reading its JSON. Only the editor tooling moves to `@decocms/blocks` v8. Keep app-specific code in the app; don't add it to a package.

## What changes

1. **Run the script as usual** and commit its output unedited. It writes `.deco/index.ts` with descriptor-returning section blocks, which `deco schema` and `deco check` need. Manual steps 2 to 4 (`createCMS`, framework code, `/deco/invoke`) don't apply.
2. **Dependencies.**
   - Remove the v7 binding package.
   - Add `@decocms/blocks@^8.1` and `typescript`, which `deco schema` needs as a peer.
   - Check the Node version that `@decocms/blocks`'s `engines` requires against the app's toolchain.
3. **Scripts.**
   - These apps usually have no `dev`/`build` npm scripts. Run `deco schema && deco check` in whatever runs before the app's own start (`prestart`, a CI step).
   - Keep the old v7 script names as aliases when other tooling, such as a content importer, calls them.
4. **Generated files.**
   - Commit `.deco/schema.gen.json`, which Studio reads for the editor forms, and delete `meta.gen.json`, `blocks.gen.json` and `generate.digests.json`.
   - Skip `deco content` when the app imports the JSON directly, and gitignore `.deco/blocks.gen.ts`.
5. **The block map isn't auto-discovered.** v7 listed every file under `sections/` as a section. In v8, a section that isn't in `.deco/index.ts` has no editor form. Say so in the app's AGENTS.md or contributor docs: a new section goes in the block map **and** in the app's component table.
   - Remove files that only hold shared types (`types.ts`) from the block map. They were never sections.
6. **Studio.**
   - `deco serve` serves the editor, from Studio at any origin (local or hosted).
   - Expect an empty preview pane: there's no web renderer. Ignore the dev-server URL that `deco serve` prints, which is a default.
   - A save rewrites the whole block file as formatted JSON, so compact inline objects become multi-line. Before the first editor session, commit a one-time reformat (`deco serve`'s formatting) so later diffs show only the edited fields.

## Parity

There's no SSR HTML to compare. A static harness covers what changes (Tier 0, no device or network needed):

| Check | What it compares |
|---|---|
| bundle | sha256 of every file the app's bundler packs, per module, minus the Deco tooling files. Any change fails. |
| content | canonical-JSON hash of each `.deco/blocks/*.json`. |
| forms | each section's editor form, from v7 `meta.gen.json` vs v8 `schema.gen.json`, reduced to form keywords (`type`, `title`, `format`, `enum`, `required`, `items`, `properties`, `anyOf`/`oneOf`/`allOf`, `default`, `description`, min/max, `additionalProperties`). |

Record the baseline on the last v7 commit, before the script runs. Add device screenshots (Tier 1) once a device or emulator build is available. Until then, rendering parity rests on the bundle check showing the packed files didn't change: say that in the PR.

Most form differences are expected. Sort them with `reference/parity.md` ("Editor-form differences") before you approve or fix anything.

## Before merging

`prestart` regenerates `schema.gen.json` from the **installed** `@decocms/blocks`. Pin a range that includes every CLI fix the committed schema depends on. Otherwise the next start brings the old form differences back. The form-fidelity fixes below shipped after `8.1.0-next.1`.
