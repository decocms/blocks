# How published content reaches the site

With `createCMS({ blocks, site })`, content is never in the bundle. The site reads it at runtime from
`https://delivery.decocms.com/sites/<site>/`, over plain HTTP with no credential. The CDN layout is in
[content-layout.md](./content-layout.md#on-the-cdn).

## The release index

- The first request loads `latest.json`, the current release's index. Requests that arrive meanwhile
  share that one load. Each fetch has 10 s.
- If that first load fails, a 404 included (the site was never published), clients answer
  `LOADER_FAILED` with a `ContentUnavailableError` cause. There is no bundled fallback and never an
  empty site. A failed load isn't kept: the next request tries again.
- After that, the CMS checks for a new release in the background every `interval` (default and
  minimum 60 000 ms, plus or minus up to 10 s). A request starts the check and never waits for it. The
  check sends `If-None-Match`, so an unchanged index is a 304.
- A read is adopted only if its `sequence` is higher than the one held, so a stale CDN answer never
  moves the site backwards. A failed check keeps the last good index.

So a publish shows on a given isolate within about 70 s, without a deploy.

## Blocks

- A request walks the routes and references in the index, then fetches the bodies it needs by hash
  (`blocks/<hash>.json`) in one parallel wave. A body never changes, so it is cached per isolate in an
  LRU of 32 MiB of JSON. Concurrent requests share one fetch per hash.
- Each request pins the index it started with.
- Right after a publish, a page whose new blocks aren't cached yet is served from the previous index
  while they load in the background. The next request gets the new content.
- An index or a body over 16 MiB is refused.

## Drafts and old releases

- A draft request (`?__draft=…` or the draft cookie) always revalidates at the CDN and never shares the
  isolate's cached copy. It checks for the latest release once, so a preview shows a release published
  a moment ago.
- A link with a release id in place of a draft (Studio's "Preview this version") reads
  `revisions/<id>/index.json`. The last three such indexes are kept in memory.
- Previews only open on allowed hosts: see [serve-and-studio.md](./serve-and-studio.md#step-5-previews-in-studio-and-on-your-machine).
- The TanStack worker never hands a preview to the site's page cache and answers it with
  `Cache-Control: max-age=0, no-cache, must-revalidate`, `Vary: Cookie` and `noindex`.

## When a publish doesn't show

| Check | Meaning |
|---|---|
| `deco releases`: is your revision `current`? | If not, the publish didn't happen or someone published after you |
| `curl -s https://delivery.decocms.com/sites/<site>/latest.json` and compare `revision` | The CDN has it; the site may not have polled yet. Wait about a minute |
| The page comes from your page cache | Key the cache on the content revision (`cacheVersion(cms, buildHash, url)` from `@decocms/tanstack/worker`). See `deco-storefront-caching` |
| The content is read outside the CMS client | Code that imports `.deco/blocks/*.json` directly, or a build script that reads `.deco/blocks`, stays on the last deploy. Read it through the client |
| The site runs without `site` | A bundled site (`content`) changes only with a deploy |
