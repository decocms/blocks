# Gotchas from the site migrations

Learned on `deco-sites/storefront-tanstack` (Shopify), `deco-sites/blog-tanstack`, two Next.js storefronts on VTEX, a TanStack Start storefront on VTEX and a non-ejected FastStore storefront on VTEX (the last five private, so no hashes; FastStore specifics are in `faststore.md`). Commit hashes refer to the two public repos.

## Before you run the script

- **Install `@decocms/blocks@^8.1` first** (`^8` resolves to the accidental v7 build published as `8.0.0`). A v7 site already has `@decocms/blocks@7`, which has no `/cli` or `/protocol/keys`; the script fails to import. Keep v7 `@decocms/apps-*` installed until after the run: vendoring copies from them.
- **Commit the script's output unedited** (`046de4d`, `de03793`), then do the manual work in follow-up commits.
- **The script vendors every app loader the content calls**, including ones the v7 site never ran (a v7 Next.js site resolved many VTEX loader blocks to `null`). Check which ones actually rendered before keeping a vendored copy; delete the rest along with the saved blocks nothing references.

## Rendering

- **v8 has no async rendering; the script removes it.** v7's `website/sections/Rendering/Lazy.tsx` and `SingleDeferred.tsx` (`{ section }`) and `Deferred.tsx` (`{ sections: [...] }`) are unwrapped in the saved content: each wrapper becomes the section(s) it held, with their props, and its own options (`loading`, `display`, `behavior`) go. Don't register a block under those names. Content that used to arrive after hydration (JSON-LD in particular) is now in the first SSR HTML. That is an approved parity difference, not a bug (`5a5a4d4`). A wrapper the script reports (several sections where one block goes) is unwrapped by hand.
- **Blocks that render nothing** (theme fonts, SEO sections' `jsonLD`): wrap their data arguments in `lazy` in content so nothing is fetched for them (`9a097a1`).
- **Awaited blocks are an exception.** The TanStack guide keeps block promises unawaited. A site whose blocks only read in-memory content may await them so every section lands in the first HTML chunk and the hero preload stays in `<head>`; stop awaiting a block once it fetches upstream (blog `dee30a5`).
- **Awaited because of response headers.** A page whose response headers depend on how its blocks resolved (a degraded-page header when a loader failed, an A/B cookie with the groups the matchers picked) has to await every block before answering, so time to first byte is the slowest block's, as in v7. That departs from the guide: say so in `open-page.server.ts`'s header and in the PR, and list streaming as a follow-up.
- **Side effects of deferred sections now start on load.** v7 rendered a deferred section once its placeholder came within 300px of the viewport, one frame after mount, so a popup, banner, timer or view event inside it started then; now it starts on page load. Gating it on the section's position in v8's layout does *not* reproduce v7: v7's pages were short while their other deferred sections were still placeholders, so a footer near the fold of a short v7 layout (a product page) mounted on load, and the gate then hides a popup v7 showed. Compare a page whose v7 layout was short as well as a long one before keeping such a gate; otherwise keep the difference as pending and explain it.
- **Section keys and wrappers.** Keep v7's `<section id data-manifest-key>` wrapper and section keys so CSS and client state survive navigations (`5bcc12b`, `0512e60`).
- **Tailwind reads every text file it scans, comments and Markdown included.** A word that is a utility name (`isolate`, `hidden`, `fixed`) in a new comment or an `AGENTS.md` line generates that class and changes the stylesheet's hash, which shows up as a different `Link` preload header on every page. Diff the built CSS against v7's after editing docs or comments.
- **Tailwind.** Code moved out of the v7 packages changes Tailwind's scan; list the classes v7 generated from deleted files inline so the stylesheet stays byte-identical. If you exclude the vendored folder from the scan (`@source not "../vendor"`, because v7 never scanned `node_modules`), a class written only there is never generated: say so in the site's agent/contributor notes.

## Framework code moves into the site

v8 has no framework binding and its apps are thin clients. What `@decocms/tanstack`, `@decocms/blocks` 7 and `@decocms/apps-*` did for the site becomes site code, copied with its v7 output (`21addb9`, `0512e60`):

- **Edge cache**: the worker entry owns cache profiles, `Cache-Control`, the Cache API with SWR/SIE, split by device/login/region, keyed by deployment. Cache GET server functions (client-side navigation data) like pages; POST server functions keep their own headers (blog `59cb74f`). Restore `/deco/_liveness` if monitoring uses it.
- **Image**: copy v7's `Image` so CDN URLs stay identical.
- **SEO/head**: a head builder; SEO blocks return the page's SEO.
- **Device detection**: v7's user-agent patterns in `src/sdk/device.ts`.
- **Cookies and request state**: pass the request and response headers explicitly, or use a site-owned `AsyncLocalStorage`, instead of v7's `RequestContext`.
- **Cart, user, wishlist, sign-in flows and commerce loaders**: vendored next to the loaders the script copied, sending through the v8 client.
- **Section loaders** run inside their block functions.
- **Module-level config from v7 apps is cross-request state.** A v7 app's `configureX({...})` singleton (the website app's SEO defaults, for one) called from the page loader on every request is shared by every request in the isolate. A preview host and production share the worker, so a draft's values can land in a concurrent release render that the edge then caches. Put per-page values in the page's own state (the `AsyncLocalStorage` the page loader runs blocks in) and pass them to whatever read the singleton.
- **Identification headers in the copied worker entry** (`x-powered-by`, the outbound `User-Agent`) are the site's own values now, not the framework's. If they change (v7 sent its package version), list it as the site's difference.
- **Keep v7's platform client, or adopt the v8 one?** Keeping the vendored v7 client (and its cached loaders and fetch cache) keeps every upstream request identical, so recorded upstream fixtures replay. If you keep it, drop the v8 `@decocms/apps-<platform>` dependency nothing imports, and list the move to its client plus the `/next/caching` recipe (`cachedLoader` is gone in v8) as a follow-up. Prune what the copied worker entry still carries for v7's admin (preview shells, `/live/previews`, `/deco/render`).
- **Error reporting.** v7's `onResolveError` hook sent every failed section or loader to the site's exception reporting. v8 has no hook: `client.resolve` returns `[value, error]`, and a section loader that throws is caught in its block function. Report both explicitly there (same attributes as before, so dashboards keep working); `console.error` alone only reaches the SDK's sampled log export.

## `/deco/invoke` → server functions

v8 has no invoke endpoint. Every call the browser made through `/deco/invoke` becomes a TanStack Start server function (`createServerFn`, e.g. `src/server/site.functions.ts`) or a Next server action/route handler, taking the request and response headers explicitly (`89895c3`). Validate inputs with zod; reject protocol-relative hrefs. Loaders that 404'd through invoke and fell back to placeholders now return real state: check those flows.

- **One server function per key, imported by the call site.** Name it after the key (`site/loaders/gateway/wishlist/add-item` → `$siteLoadersGatewayWishlistAddItem`) and rewrite each call: `invoke.a.b(props)` → `$aB({ data: props })` (a script over the call sites does most of it; chains split across lines and bracket keys like `["can-spin"]` are the usual misses). The server function imports its handler module and calls it with the props and the request, then forwards the cookies the handler set. Never a `runInvoke(key)` lookup over the commerce-loader map: that is v7's endpoint again.
- **v7's invoke passed no app context.** It called `handler(body, request)`. A site loader that reads its third argument (account, secrets) worked when a page ran it (the block map passed them) and threw through invoke. Give its server function the context the block map passes.
- **Keys v7 had no handler for** failed with "handler not found". Keep them failing explicitly at the call site (a rejected promise with a comment saying v7 failed too), not as stubs in a rebuilt `invoke` tree, and list them as follow-ups.
- **Check the client bundle.** TanStack Start's compiler replaces each handler with an RPC stub and drops its imports; grep `dist/client` JavaScript (not source maps) for secret env names and `node:async_hooks` after the build.
- v7's generated `invoke.gen.ts` (cart and session actions) is site code now: export each action as its own server function and delete the ones nothing calls.

## Caching and privacy

- **Keep per-visitor data out of the edge cache** (`844ce9f`): cache a GET server function only when its payload is page data; cart, user, wishlist, addresses answer `Cache-Control: private, no-store`, and the cache wrapper never stores such a response. Detect signed-in shoppers by the cookie the sign-in flow actually sets.
- **One QueryClient per router**, never per isolate: a shared one leaks the previous request's cart and user.
- v7's admin paths (`/deco/*`, `/live/*`, `/.decofile`) should answer 404, not a cacheable page.
- Read drafts with `await cms.draftPointer(request)`; it ignores drafts on hosts outside `preview.hosts` (the `CMS` block, capped by `createCMS({ preview })`), so list your staging and dev hosts there.
- **Gate the copied worker entry's draft bypass on the pointer too.** v7's edge cache skipped a request with `?__draft=` or the draft cookie only on an allowed preview host. A copy that checks the raw param or cookie lets anyone skip the edge cache on production (`?__draft=x`), so every such request reaches the worker and the commerce API. Compute `const previewing = (await cms.draftPointer(request)) !== null` once per request and use it wherever the copy checked for a draft.
- **Don't let hydration wait on a cross-origin call.** Prefetching the shopper's profile in the router's `hydrate` so widgets hydrate with it keeps v7's pixels, but `hydrate` is awaited: a slow or hung gateway keeps the page from ever becoming interactive. Cap the wait (a few hundred milliseconds) or don't await it. A parity harness replays upstream calls, so it never shows this cost.

## Next.js App Router

- **`transpilePackages: ['@decocms/blocks']`** only while the installed package's `exports` point at `.ts` source (see SKILL.md, step 1); `8.1.0-next.7` ships `dist/` and needs none. A linked local checkout ships `dist/` and hides the difference; so does every parity run made against it.
- **Drafts on Pages Router SSG pages** (no proxy available, as on FastStore): Next 16's compiled pages runtimes inline `tryGetPreviewData`, so a `require.cache` patch never runs. See `faststore.md`.
- **Drafts on static pages.** `force-static`/ISR pages get stubbed `cookies()`, so they can't read the draft pointer. Divert drafted requests (`?__draft=` or the draft cookie) in `proxy.ts` onto a dynamic route group that binds the pointer, and 404 direct hits on that internal route. Send `Cache-Control: no-store, private` and `X-Robots-Tag: noindex` on both signals.
- **The proxy runs on every request: keep the CMS out of it for ordinary traffic.** Ask `cms.draftPointer`/`cms.draftCookie` only when the request has `?__draft=` or the `__deco_draft` cookie (the SDK doesn't export the names yet; pin them in a test). Give the proxy its own `createCMS` handle with `blocks: {}` and the same options as the app's (one shared options module, since a second call with other options keeps the first): the draft helpers read only the `CMS` settings block, so the block map, its section loaders and what they import (a GraphQL engine) leave the proxy bundle. Measured on one store: 2.2 MB to 1.5 MB, traced files 3,245 to 364. The content module still lands there.
- **A pointer that doesn't parse.** `cms.draftPointer` returns the raw `?__draft=`/cookie value and `cms.forDraft` throws on one that doesn't parse, so `?__draft=junk` on a preview host answers 500. Treat `parseDraftPointer(pointer) === null` as no draft, in the proxy and the page.
- **Views wrapped in `next/dynamic`.** The script types each section from its view (`PropsOf<view>`). A lazy view that re-exports a `next/dynamic` wrapper loses its props type, and its form collapses. Type those sections from the component module (`section<import("…").Props>(…)`) and diff the forms against v7's.
- **`list('page')` order.** It sorts by block name; v7 listed saved pages in file order. Output that lists pages in order (a sitemap) has to keep v7's order explicitly.
- **List pages once per revision.** `list('page')` expands every page's saved-block references; on a site with hundreds of pages that is tens of milliseconds of CPU. Keep the routable list per revision (a revision never changes, a draft has its own) and hand the same array to `matchRoute` so it reuses its lookup. Health and readiness probes go through the same cache, never a fresh `list`.
- **Head meta order.** If v7 emitted `theme-color`/`color-scheme` after the root layout's metas on some routes, that was a race with Next's viewport resolution. To keep the order deterministic, render those tags from the segment layout (React hoists in tree order) rather than approving a reorder. The race can go the other way: where v7 had the viewport tags *before* the root layout's metas and v8's faster shell now wins, a segment layout can't move them earlier. Look for a deterministic fix (the tags rendered ahead of the root layout's metas on every route, checked against every route's head), and keep the reorder pending, with that reasoning, if none holds.
- **Jest** is CJS-only: transform `@decocms/blocks` (ESM) with ts-jest and keep it out of `transformIgnorePatterns`. When mocking a site module in a test, spread `jest.requireActual` so sibling exports other code imports stay real.

## Hosted releases and bundled content

**v7 fast deploy becomes the hosted CMS.** A v7 TanStack site that published content without a deploy (`DECO_FAST_DEPLOY` plus a `DECO_KV` namespace) needs `site` on `createCMS` for the same feature (and `token` for hosted telemetry): the site reads its own `DECO_SITE` var and `DECO_SITE_TOKEN` secret and passes them, since the SDK reads no environment variable; without `site` every content change needs a deploy. Put the two `wrangler secret put` commands in the deploy checklist. v7's fast deploy also kept the content out of the bundle; v8 bundles it, and hosted mode loads a second copy. On a site with ~300 saved blocks (11 MB of JSON), Node measured about 13 MB per parsed copy, plus the bundled module's source (about the size of the JSON) and a transient string up to twice the JSON while a snapshot parses: under the Workers 128 MB limit, but measure memory and cold start with `wrangler tail` on a preview before turning it on.

With `site` set on `createCMS`, a published release goes live without a deploy, but only for what reads through the CMS client. Before turning it on, grep for direct imports of `.deco/blocks/*.json` (redirects, proxy tables, config blocks) and for build-time scripts that read `.deco/blocks`: those stay on the last deploy. v7 behaved the same, so it isn't a parity break; route them through the client or document the limitation and keep hosted releases off until you do.

## v7 leftovers to delete

- Env vars and comments for the v7 admin protocol (`DANGEROUSLY_ALLOW_PUBLIC_ACCESS`, admin public keys) and for settings that lived in the v7 `site` app block.
- Middleware/proxy exclusions for `/deco`, `/live` and `/.decofile`: the routes are gone. Removing the exclusion sends these paths down the unknown-path route, which may ask upstream (a redirect lookup) on every stray hit from old tooling and scanners; keeping it may send them to a catch-all that does worse (a search fallback answering 200). Skip the upstream work for them explicitly, and check the status (404) and the upstream calls for each path in the parity run.
- Add the site's new env vars (`DECO_SITE`, `DECO_SITE_TOKEN`, which the site passes as `createCMS({ site, token })`) to its env example, the token marked secret, and blank them in parity runs.
- **Editor settings that disappear with the `site` block.** Deleting the v7 `site` app block (apps are code now) also deletes any setting editors changed there, such as draft preview hosts. Moving it to code or env is fine, but it is an editor-visible change: list it for the product owner.

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
- **Reload open pages when `.deco/blocks.gen.ts` changes.** Only the server imports it, so Vite swaps it without touching the browser: a small Vite plugin (`apply: "serve"`, `hotUpdate`) sends `full-reload` to the client environment. Without it the site editor's preview keeps showing the old content until a manual reload.

## Telemetry and analytics

- Telemetry is explicit params only: the SDK reads no environment variable (`OTEL_*` and v7's `DECO_OTEL_*` are ignored). A site that kept a collector reads its own variables and passes `telemetry: { endpoint, headers }`; with `createCMS({ site, token })` and no `endpoint`, telemetry goes to the hosted collector (a `token` without `site` is a configuration error). Pass `telemetry: false` in dev or parity runs (`89eae7d`). v7's per-signal `DECO_OTEL_{METRICS,LOGS,TRACES}_ENDPOINT` have no v8 equivalent: every signal goes to `<endpoint>/v1/<signal>`.
- **New telemetry is a behaviour change.** A site with its own OpenTelemetry export that v7 never fed CMS telemetry starts sending it once `telemetry` points at that collector. List the new traffic for the product owner.
- `service.version` (and `deployment.environment.name`, default `production`) come from `telemetry.resource`: pass the build's commit (a Vite `define` on Workers, which have no commit variable at runtime). v7 read the deployment id from the `CF_VERSION_METADATA` binding.
- **v7 Workers bindings with no v8 writer.** v7's `instrumentWorker` wrote per-route request counts, edge cache hit/miss and request duration to an Analytics Engine dataset (`DECO_METRICS`) and read `CF_VERSION_METADATA`; v8 has no metric API for them. Don't keep the bindings as dead config, and don't drop them silently: list each by name (and the edge layer's `deco.cache.requests` counter) as a product decision in the PR, since the dashboards built on them go dark.
- Analytics: `AnalyticsScript` with `(await cms.settings()).analytics` plus `track` replace OneDollarStats (the collector lives in the `analytics` section of `CMS.json`); it sends collector beacons directly instead of loading the SDK (`4a50b13`, blog `9e97455`).

## Dependencies

- `bun.lock`: don't commit a lock produced by `bun link`; regenerate once the v8 packages resolve from npm.
- A linked checkout writes `"version": "0.0.0"` into `.deco/schema.gen.json`; the published CLI writes its own version. Commit what a clean `install --frozen-lockfile && build` writes.
