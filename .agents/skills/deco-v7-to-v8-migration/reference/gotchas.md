# Gotchas from the site migrations

Learned on `deco-sites/storefront-tanstack` (Shopify) and `deco-sites/blog-tanstack`. Commit hashes refer to those repos.

## Before you run the script

- **Install `@decocms/blocks@^8.1` first** (`^8` resolves to the accidental v7 build published as `8.0.0`). A v7 site already has `@decocms/blocks@7`, which has no `/cli` or `/protocol/keys`; the script fails to import. Keep v7 `@decocms/apps-*` installed until after the run: vendoring copies from them.
- **Commit the script's output unedited** (`046de4d`, `de03793`), then do the manual work in follow-up commits.

## Rendering

- **Lazy wrappers render normally.** v7's `website/sections/Rendering/Lazy.tsx` (and `Deferred`/`SingleDeferred`) is registered as a block that renders its section. Blocks resolve on the server, so content that used to arrive after hydration (JSON-LD in particular) is now in the first SSR HTML. That is an approved parity difference, not a bug (`5a5a4d4`).
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

## `/deco/invoke` → server functions

v8 has no invoke endpoint. Every call the browser made through `/deco/invoke` becomes a TanStack Start server function (`createServerFn`, e.g. `src/server/site.functions.ts`) or a Next server action/route handler, taking the request and response headers explicitly (`89895c3`). Validate inputs with zod; reject protocol-relative hrefs. Loaders that 404'd through invoke and fell back to placeholders now return real state: check those flows.

## Caching and privacy

- **Keep per-visitor data out of the edge cache** (`844ce9f`): cache a GET server function only when its payload is page data; cart, user, wishlist, addresses answer `Cache-Control: private, no-store`, and the cache wrapper never stores such a response. Detect signed-in shoppers by the cookie the sign-in flow actually sets.
- **One QueryClient per router**, never per isolate: a shared one leaks the previous request's cart and user.
- v7's admin paths (`/deco/*`, `/live/*`, `/.decofile`) should answer 404, not a cacheable page.
- Read drafts with `draftPointer()`.

## Content

- `deco check` rejects fields no type declares, `.tsx`-named preview blocks and dangling references: delete or type them (`9a097a1`, `ffa866a`).
- v7 app blocks (`deco-shopify`, `deco-blog`, `site`) go: apps are code now, configured from env (e.g. `SHOPIFY_STORE_NAME`). Don't re-encrypt secrets runtime code never reads.
- `website/functions/requestToParam.ts` in a string field becomes the page's route `param` (`/:slug`) the block reads itself.
- Register blocks under their v7 names only, or the site editor lists them twice (`57561bd`).

## Telemetry and analytics

- Telemetry: set `OTEL_EXPORTER_OTLP_ENDPOINT` to the OTLP collector and the auth header as the `OTEL_EXPORTER_OTLP_HEADERS` secret in production; send nothing in dev or parity runs (`89eae7d`).
- Analytics: the built-in `analytics` block plus `AnalyticsScript`/`track` replace OneDollarStats; it sends collector beacons directly instead of loading the SDK (`4a50b13`, blog `9e97455`).

## Dependencies

- `bun.lock`: don't commit a lock produced by `bun link`; regenerate once the v8 packages resolve from npm.
