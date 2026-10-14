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

`deco serve` rewrites `.deco/blocks.gen.ts` on every save. What makes the save show up depends on the framework (recipes: the TanStack Start and Next.js guides, "Edit in the site editor"):

- **Vite sites: add `decoContent()` from `@decocms/blocks/vite` to `vite.config.ts`** (`plugins: [..., decoContent()]`, from the first `@decocms/blocks` release after 8.2.1). It runs in `vite dev` only and leaves the generated file on disk as it is. In the server environments (the `@cloudflare/vite-plugin` worker, whatever it's named, `rsc`, plain SSR) it makes `.deco/blocks.gen.ts` accept its own updates: the new module goes into the CMS already created for that `.deco` folder (`adoptContent`, keeping that CMS's options), and only then does the server tell open pages to `full-reload`, once per save. Next.js sites don't add anything.
- **Drop the two pieces of template code it replaces.** Sites made before it carry an `import.meta.hot.accept("../.deco/blocks.gen", ...)` block in `src/cms.ts` that calls `createCMS` again and sends `site:content-updated`, plus a `site-content-reload` plugin in `vite.config.ts` that turns that event into `full-reload`. Leaving them in place next to `decoContent()` is harmless (the content module accepts its own update first, so the `cms.ts` callback no longer runs and that event is never sent; there's no second reload), but they're dead code. Without the plugin, keep them: they still work.
- **Why it's built that way.** Re-running `src/cms.ts` on a save leaves server functions holding the old module, and the first request after a save fails with `client is not a function`; the content module accepting itself means `cms.ts` never runs again. Reloading on the file change (a `hotUpdate` hook) is too early: the worker hasn't re-imported the content yet, so the page renders the previous save and the site editor's preview stays one edit behind. Without any reload the preview keeps the old content until a manual reload.
- **Run it inside the site's git repository.** From `@decocms/blocks` 8.2.0, `deco serve` refuses to start outside a git work tree (or without git installed) and says what to run (`git init`, or clone the site). The site editor's change list compares the blocks with the last commit (`HEAD`), and discarding a change restores the committed file. The site editor needs `deco serve` from 8.2.0 or newer; an older one shows "This deco serve is out of date".
