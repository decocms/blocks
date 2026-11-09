# Content releases, publish timing and rollback

On v8, published content is a **release**: a revision Studio writes to the
delivery CDN. The worker does not bundle it and does not keep it in a KV
namespace. This file covers what to check about that path before go-live, and
how to roll back each layer.

## How a release reaches the site

- `createCMS({ blocks, site })` reads the site's latest release from the delivery CDN at runtime. With `site`, passing `content` too is an error: content never comes from the bundle.
- The first client of an isolate loads the release index (10 s per fetch). Until a load succeeds, reads fail with a `ContentUnavailableError` cause. Test a cold start: the first request after a deploy must render.
- Each isolate checks for a newer release every `interval` (default and minimum 60 000 ms, plus or minus up to 10 s), at an idle moment, in the background. So a publish shows up within about a minute per isolate, and the first request after the interval may still render the previous release. Tell the content team; the old stack may have felt instant.
- A draft or preview request checks for the latest release once, so a preview shows what was published a moment ago.
- Block bodies are fetched by hash and kept in a per-isolate LRU bounded at 32 MB of JSON text. A hash always means the same body, so nothing there is invalidated.
- Without `site`, content is the module `deco content` writes (`.deco/blocks.gen.ts`), bundled into the worker, and every content change needs a deploy. Large content in the bundle costs memory on every isolate ([worker-runtime.md](./worker-runtime.md#memory-128-mb-per-isolate)).

Setting `site` and `token` (and the `DECO_SITE` / `DECO_SITE_TOKEN` values a
site passes to them) is covered in **deco-site-workflow** and, for a v7 site,
in **deco-v7-to-v8-migration**.

### What a publish does not reach

A publish changes only what reads through the CMS client. Before go-live, grep
for content that bypasses it:

```bash
grep -rnE "\.deco/blocks/[^\"']+\.json" src           # direct JSON imports: frozen at the last deploy
grep -rn "blocks.gen" src                              # the bundled content module
grep -rln "readFileSync\|readdirSync" scripts 2>/dev/null | xargs grep -ln "\.deco/blocks" 2>/dev/null   # build-time reads
```

Route each through the client, or write down that it needs a deploy.

### Page cache and releases

`cacheVersion(cms, buildHash, page.url)` from `@decocms/tanstack/worker` is
`<build>.<content revision>`, so a deploy or a publish moves the site's page
cache to new keys at once. A preview (`?__draft=`, `off` included, or the
draft cookie) never reaches `pageCache`, and an old release is never stored.
Cache keys and profiles are in **deco-storefront-caching**.

## Check the release before you publish

```bash
deco check                          # production against the local .deco/schema.gen.json
deco check --draft=<name>           # a draft
deco check --revision=<id>          # a published revision (ids from deco releases)
```

`deco check` validates content against the local schema. Run it on the
commit you are about to deploy: a deploy that changes a section's props can
reject content that is already live.

The schema the site editor draws forms from must be the deployed one: `deco
schema push` on every production deploy (**deco-site-workflow**). The
committed `.deco/schema.gen.json` must carry `"blocksMajor": 8`, or `deco check`
fails and the editor treats the site as v7.

## Redirects are content

The worker answers the redirects block (the saved block of type `redirects`)
before any route, including before an A/B split. They ship with a publish, not
with a deploy. Their rules and the sweep against the old site are in
[seo-analytics.md](./seo-analytics.md#redirect-sweep).

## Rollback

Write down one path per layer before cutover, and rehearse each on the
candidate.

| Layer | How | Check |
|---|---|---|
| Traffic | Set the split ratio back to 0 in the host's KV entry, or remove the route ([traffic-ramp.md](./traffic-ramp.md)) | `x-deco-bucket: fallback` on a fresh visitor |
| Content | In Studio, make an earlier release current. It becomes a new revision with the next sequence, and isolates adopt it within the interval | `deco releases` lists it as `rollback to <id>`, marked `current` |
| Code | Roll back the Worker deployment (the Cloudflare dashboard's Deployments, as in this repo's `docs/runbooks/http-error-spike.md`) | `service.version` in telemetry flips back. It is `unknown` unless the site sets it in `telemetry.resource` (e.g. to the commit): set it before go-live |

A code rollback keeps the content that is live now. Before rolling code back,
check out the older commit and run `deco check`: if live content no longer
fits the older schema, roll content back first, or the older code renders it
wrong.

## Telemetry

With `token` (or a `telemetry.endpoint`), the worker records
`http.server.request.duration` for every request, labelled with the page
template, method, status class, cache decision (`HIT`, `MISS`, `BYPASS`,
`DRAFT`) and device. Upstream calls made through `createInstrumentedFetch`
(`@decocms/blocks/fetch`) record `http.client.request.duration` per provider.
Without either, nothing is sent: confirm it is on before the ramp, or you
compare buckets blind.
