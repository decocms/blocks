# Content and local editing

From the site migrations; the sites and what the commit hashes refer to are listed in `SKILL.md` ("Gotchas by subject").

## Content

- **`deco check` in the build gates the deploy.** Once `build` runs it, a Studio save or a content importer that writes something check rejects fails the next deploy. Make importers emit check-clean content (and run `deco check` at their end), and say in the README that the gate exists.
- **Don't let rendering depend on undeclared `__`-prefixed fields.** `deco check` accepts `_`/`$`/`@` keys, but the docs say the site editor keeps only declared fields, and whether those keys survive a save isn't documented. Routing data (a page type) belongs in a declared field.
- **Case-only name pairs.** Two saved blocks whose names differ only by letter case can't coexist on macOS disks; v7 silently bundled one. Check which one content references, keep it, and fail the build on such a pair (reading the git index too). v8's write path refuses new ones; `deco check` doesn't flag an existing pair.
- **Required fields saved content omits.** `deco check` rejects a saved block missing a field its type requires, which v7 tolerated. If the component renders without it, make the field optional (an editor-visible change to list), and don't fill content with placeholders.
- `deco check` rejects fields no type declares, `.tsx`-named preview blocks and dangling references: delete or type them (`9a097a1`, `ffa866a`).
- v7 app blocks (`deco-shopify`, `deco-blog`, `site`) go: apps are code now, configured from the deploy platform's variables and secrets (e.g. `SHOPIFY_STORE_NAME`), passed as params. Delete each v7 secret block once its value is in the deploy platform's secrets.
- `website/functions/requestToParam.ts` in a string field becomes the page's route `param` (`/:slug`) the block reads itself.
- Register blocks under their v7 names only, or the site editor lists them twice (`57561bd`).

## Publishing and editing content (no `deco serve`)

Content isn't bundled and `deco serve` is gone: the site's `createCMS({ blocks, site })` fetches the latest release from the CDN at runtime.

- **Publish the migrated content once.** `deco link <org>/<site>` (commit `.deco/link.json`), then `deco push --draft=<name>` sends `.deco/blocks` to a draft, and `deco publish --draft=<name>` makes it live. Then delete `.deco/blocks` and git-ignore it; `deco pull` fills it again when you need it.
- **Edit in Studio, or locally with the CLI.** `deco pull [--draft=<name>]`, edit `.deco/blocks/*.json`, `deco check && deco diff`, `deco push --draft=<name>`. A push never publishes; only `deco publish` goes live.
- **Schema.** On production deploys run `deco schema && deco schema push` (a Studio API key as `DECO_TOKEN`) so Studio's forms follow the deployed code. Add `deco check` there for the guard: with no `.deco/blocks` it checks production.
