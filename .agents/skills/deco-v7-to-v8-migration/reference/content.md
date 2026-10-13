# Content and local editing

From the site migrations; the sites and what the commit hashes refer to are listed in `SKILL.md` ("Gotchas by subject").

## Content

- **`deco check` in the build gates the deploy.** Once `build` runs it, a Studio save or a content importer that writes something check rejects fails the next deploy. Make importers emit check-clean content (and run `deco check` at their end), and say in the README that the gate exists.
- **Don't let rendering depend on undeclared `__`-prefixed fields.** `deco check` accepts `_`/`$`/`@` keys, but the docs say the site editor keeps only declared fields, and whether those keys survive a save isn't documented. Routing data (a page type) belongs in a declared field.
- **Case-only name pairs.** Two saved blocks whose names differ only by letter case can't coexist on macOS disks; v7 silently bundled one. Check which one content references, keep it, and fail the build on such a pair (reading the git index too). v8's write path refuses new ones; `deco content`/`deco check` don't flag an existing pair.
- **Required fields saved content omits.** `deco check` rejects a saved block missing a field its type requires, which v7 tolerated. If the component renders without it, make the field optional (an editor-visible change to list), and don't fill content with placeholders.
- `deco check` rejects fields no type declares, `.tsx`-named preview blocks and dangling references: delete or type them (`9a097a1`, `ffa866a`).
- v7 app blocks (`deco-shopify`, `deco-blog`, `site`) go: apps are code now, configured from env (e.g. `SHOPIFY_STORE_NAME`). Don't re-encrypt secrets runtime code never reads.
- `website/functions/requestToParam.ts` in a string field becomes the page's route `param` (`/:slug`) the block reads itself.
- Register blocks under their v7 names only, or the site editor lists them twice (`57561bd`).

## Editing locally (`deco serve`)

v8 ships no dev hook for content changes; two pieces of template code make a save show up (recipes: the TanStack Start and Next.js guides, "Edit in the site editor"):

- **Take a new content module without re-running `src/cms.ts`.** On Vite, accept `../.deco/blocks.gen` in `cms.ts` and hand the new module to `createCMS` again (it adopts it for the same `.deco` root and returns the same instance). Re-running `cms.ts` instead leaves server functions holding the old module, and the first request after a save fails with `client is not a function`.
- **Reload open pages once the server has the new content, not when the file changes.** Only the server imports `.deco/blocks.gen.ts`, so Vite swaps it without touching the browser, and open pages need a reload. Send it from the `cms.ts` accept callback, after `createCMS` takes the new module (`import.meta.hot.send("site:content-updated")`), and have a small Vite plugin (`apply: "serve"`) listen in `configureServer` (`server.environments.ssr.hot.on(...)`) and send `full-reload` to the client environment. A `hotUpdate` hook on the file change reloads too early: the worker hasn't re-imported the content yet, so the page renders the previous save and the site editor's preview stays one edit behind. Without any reload the preview keeps the old content until a manual reload.
