# Gotchas from the site migrations

Learned on `deco-sites/storefront-tanstack` (Shopify), `deco-sites/blog-tanstack` and a Next.js storefront on VTEX (private, so no hashes). Commit hashes refer to the two public repos.

## Before you run the script

- **Install `@decocms/blocks@^8.1` first** (`^8` resolves to the accidental v7 build published as `8.0.0`). A v7 site already has `@decocms/blocks@7`, which has no `/cli` or `/protocol/keys`; the script fails to import. Keep v7 `@decocms/apps-*` installed until after the run: vendoring copies from them.
- **Commit the script's output unedited** (`046de4d`, `de03793`), then do the manual work in follow-up commits.
- **The script vendors every app loader the content calls**, including ones the v7 site never ran (a v7 Next.js site resolved many VTEX loader blocks to `null`). Check which ones actually rendered before keeping a vendored copy; delete the rest along with the saved blocks nothing references.

## Rendering

- **v8 has no async rendering; the script removes it.** v7's `website/sections/Rendering/Lazy.tsx` and `SingleDeferred.tsx` (`{ section }`) and `Deferred.tsx` (`{ sections: [...] }`) are unwrapped in the saved content: each wrapper becomes the section(s) it held, with their props, and its own options (`loading`, `display`, `behavior`) go. Don't register a block under those names. Content that used to arrive after hydration (JSON-LD in particular) is now in the first SSR HTML. That is an approved parity difference, not a bug (`5a5a4d4`). A wrapper the script reports (several sections where one block goes) is unwrapped by hand.
- **Blocks that render nothing** (theme fonts, SEO sections' `jsonLD`): wrap their data arguments in `lazy` in content so nothing is fetched for them (`9a097a1`).
- **Awaited blocks are an exception.** The TanStack guide keeps block promises unawaited. A site whose blocks only read in-memory content may await them so every section lands in the first HTML chunk and the hero preload stays in `<head>`; stop awaiting a block once it fetches upstream (blog `dee30a5`).
- **Section keys and wrappers.** Keep v7's `<section id data-manifest-key>` wrapper and section keys so CSS and client state survive navigations (`5bcc12b`, `0512e60`).
- **Tailwind.** Code moved out of the v7 packages changes Tailwind's scan; list the classes v7 generated from deleted files inline so the stylesheet stays byte-identical.

## Framework code moves into the site

v8 has no framework binding and its apps are thin clients. What `@decocms/tanstack`, `@decocms/blocks` 7 and `@decocms/apps-*` did for the site becomes site code, copied with its v7 output (`21addb9`, `0512e60`):

- **Edge cache**: the worker entry owns cache profiles, `Cache-Control`, the Cache API with SWR/SIE, split by device/login/region, keyed by deployment. Cache GET server functions (client-side navigation data) like pages; POST server functions keep their own headers (blog `59cb74f`). Restore `/deco/_liveness` if monitoring uses it.
- **Image**: copy v7's `Image` so CDN URLs stay identical.
- **SEO/head**: a head builder; SEO blocks return the page's SEO.
- **Device detection**: v7's user-agent patterns in `src/sdk/device.ts`.
- **Cookies and request state**: pass the request and response headers explicitly, or use a site-owned `AsyncLocalStorage`, instead of v7's `RequestContext`.
- **Cart, user, wishlist, sign-in flows and commerce loaders**: vendored next to the loaders the script copied, sending through the v8 client.
- **Section loaders** run inside their block functions.
- **Error reporting.** v7's `onResolveError` hook sent every failed section or loader to the site's exception reporting. v8 has no hook: `client.resolve` returns `[value, error]`, and a section loader that throws is caught in its block function. Report both explicitly there (same attributes as before, so dashboards keep working); `console.error` alone only reaches the SDK's sampled log export.

## `/deco/invoke` → server functions

v8 has no invoke endpoint. Every call the browser made through `/deco/invoke` becomes a TanStack Start server function (`createServerFn`, e.g. `src/server/site.functions.ts`) or a Next server action/route handler, taking the request and response headers explicitly (`89895c3`). Validate inputs with zod; reject protocol-relative hrefs. Loaders that 404'd through invoke and fell back to placeholders now return real state: check those flows.

## Caching and privacy

- **Keep per-visitor data out of the edge cache** (`844ce9f`): cache a GET server function only when its payload is page data; cart, user, wishlist, addresses answer `Cache-Control: private, no-store`, and the cache wrapper never stores such a response. Detect signed-in shoppers by the cookie the sign-in flow actually sets.
- **One QueryClient per router**, never per isolate: a shared one leaks the previous request's cart and user.
- v7's admin paths (`/deco/*`, `/live/*`, `/.decofile`) should answer 404, not a cacheable page.
- Read drafts with `await cms.draftPointer(request)`; it ignores drafts on hosts outside `preview.hosts` (the `CMS` block, capped by `createCMS({ preview })`), so list your staging and dev hosts there.

## Next.js App Router

- **`transpilePackages: ['@decocms/blocks']`** while the published package ships `.ts` source (see SKILL.md, step 1). A linked local checkout ships `dist/` and hides this; so does every parity run made against it.
- **Drafts on static pages.** `force-static`/ISR pages get stubbed `cookies()`, so they can't read the draft pointer. Divert drafted requests (`?__draft=` or the draft cookie) in `proxy.ts` onto a dynamic route group that binds the pointer, and 404 direct hits on that internal route. Send `Cache-Control: no-store, private` and `X-Robots-Tag: noindex` on both signals.
- **List pages once per revision.** `list('page')` expands every page's saved-block references; on a site with hundreds of pages that is tens of milliseconds of CPU. Keep the routable list per revision (a revision never changes, a draft has its own) and hand the same array to `matchRoute` so it reuses its lookup. Health and readiness probes go through the same cache, never a fresh `list`.
- **Head meta order.** If v7 emitted `theme-color`/`color-scheme` after the root layout's metas on some routes, that was a race with Next's viewport resolution. To keep the order deterministic, render those tags from the segment layout (React hoists in tree order) rather than approving a reorder.
- **Jest** is CJS-only: transform `@decocms/blocks` (ESM) with ts-jest and keep it out of `transformIgnorePatterns`. When mocking a site module in a test, spread `jest.requireActual` so sibling exports other code imports stay real.

## Hosted releases and bundled content

With `site` and `token` set on `createCMS`, a published release goes live without a deploy, but only for what reads through the CMS client. Before turning it on, grep for direct imports of `.deco/blocks/*.json` (redirects, proxy tables, config blocks) and for build-time scripts that read `.deco/blocks`: those stay on the last deploy. v7 behaved the same, so it isn't a parity break; route them through the client or document the limitation and keep hosted releases off until you do.

## v7 leftovers to delete

- Env vars and comments for the v7 admin protocol (`DANGEROUSLY_ALLOW_PUBLIC_ACCESS`, admin public keys) and for settings that lived in the v7 `site` app block.
- Middleware/proxy exclusions for `/deco`, `/live` and `/.decofile`: those routes are gone, and keeping them special only hides that they now 404.
- Add the new env vars (`DECO_SITE`, `DECO_SITE_TOKEN`) to the site's env example, marked secret, and blank them in parity runs.
- **Editor settings that disappear with the `site` block.** Deleting the v7 `site` app block (apps are code now) also deletes any setting editors changed there, such as draft preview hosts. Moving it to code or env is fine, but it is an editor-visible change: list it for the product owner.

## Content

- `deco check` rejects fields no type declares, `.tsx`-named preview blocks and dangling references: delete or type them (`9a097a1`, `ffa866a`).
- v7 app blocks (`deco-shopify`, `deco-blog`, `site`) go: apps are code now, configured from env (e.g. `SHOPIFY_STORE_NAME`). Don't re-encrypt secrets runtime code never reads.
- `website/functions/requestToParam.ts` in a string field becomes the page's route `param` (`/:slug`) the block reads itself.
- Register blocks under their v7 names only, or the site editor lists them twice (`57561bd`).

## Editing locally (`deco serve`)

v8 ships no dev hook for content changes; two pieces of template code make a save show up (recipes: the TanStack Start and Next.js guides, "Edit in the site editor"):

- **Take a new content module without re-running `src/cms.ts`.** On Vite, accept `../.deco/blocks.gen` in `cms.ts` and hand the new module to `createCMS` again (it adopts it for the same `.deco` root and returns the same instance). Re-running `cms.ts` instead leaves server functions holding the old module, and the first request after a save fails with `client is not a function`.
- **Reload open pages when `.deco/blocks.gen.ts` changes.** Only the server imports it, so Vite swaps it without touching the browser: a small Vite plugin (`apply: "serve"`, `hotUpdate`) sends `full-reload` to the client environment. Without it the site editor's preview keeps showing the old content until a manual reload.

## Telemetry and analytics

- Telemetry: set `OTEL_EXPORTER_OTLP_ENDPOINT` to the OTLP collector and the auth header as the `OTEL_EXPORTER_OTLP_HEADERS` secret in production; send nothing in dev or parity runs (`89eae7d`).
- Analytics: `AnalyticsScript` with `(await cms.settings()).analytics` plus `track` replace OneDollarStats (the collector lives in the `analytics` section of `CMS.json`); it sends collector beacons directly instead of loading the SDK (`4a50b13`, blog `9e97455`).

## Dependencies

- `bun.lock`: don't commit a lock produced by `bun link`; regenerate once the v8 packages resolve from npm.
