# Previewing a variant, a test or a moment

An editor wants to see variant B before it is live, a test that sits at 0%, or the Black Friday page a week early. A Studio preview link carries all three. Code: `packages/blocks/src/v8/draft.ts` (parsing) and `packages/blocks/src/v8/variants.ts` (forcing a variant).

You rarely build these links by hand: Studio writes them. This page is for reading one, debugging one that shows the saved content instead, or building one in a tool.

## What a link carries

A preview link is `?__draft=<value>`. The value is a version plus preview parameters:

- **The version**: a draft pointer, `<host[:port]><path[?query]>@<version>`, or a published release's revision id.
- **Forced variants**, inside a draft pointer's query: `__variant=<block>@<path>=<index>`, one per multivariate.
- **The moment**: `__at=<ISO date-time with offset>`, which becomes the client's `date` (campaigns are checked at it).
- **Tests**: `__test=<name>=on|off`, which becomes the client's `experiments`.
- **Campaigns**: `__campaign=<name>=on|off`, which becomes the client's `campaigns`.

Each parameter value is URL-encoded as a whole. The last `__test` or `__campaign` for a name wins. After a revision id, only `__at`, `__test` and `__campaign` are allowed: `<id>?__at=…&__test=…`. Forced variants need a draft pointer.

The binding reads the link with `cms.readVersion(request)`. It answers `{ version, date?, experiments?, campaigns? }`, shaped to spread into `cms.client()`, and `null` for a value that does not parse. `parseVersion(value)` from `@decocms/blocks` parses a raw value the same way, with no host check. Only `cms.readVersion` checks the request's host against the preview hosts, so a visitor on the live site never picks a version or switches a test. Build on `cms.readVersion`, not on `parseVersion`, when the value comes from a request.

## Forcing a variant

`__variant=<block>@<path>=<index>` addresses one multivariate:

- `block` is the saved block's name (`Home Page`, `Header`).
- `path` is the dot-separated keys and list indexes to the multivariate inside that block's saved JSON, or empty for the saved block itself. It walks the JSON as saved, including a `lazy` block's `value`.
- `index` is the variant to show, counted from 0.

| Address | Forces |
|---|---|
| `Home Page@sections.3=1` | The second variant of the multivariate at `sections[3]` of `Home Page` |
| `Header@=0` | The first variant of the saved block `Header`, itself a multivariate |
| `Home@sections.0.variants.1.value.value.title=0` | The first variant of the `title` multivariate of the section held by variant 1 of the multivariate at `sections[0]` (through that variant's `lazy` wrapper) |

The addressed multivariate keeps only that variant, with its rule set to `true`. No other rule in it runs. The body is copied along the addressed path only; the shared content is never touched. Legacy multivariate type names count too.

`formatDraftPointer({ host, path, version, variants })` builds a pointer with its `__variant` parameters, and `parseDraftPointer(value)` reads one back: `variants` lists `{ block, path, index }`. Both are exported from `@decocms/blocks`. `formatDraftPointer` throws on parts that would not parse back.

## A preview that shows the saved content

An address that does not reach a multivariate with that variant is ignored, so a stale link renders the content as saved instead of failing. Check, in order:

1. **The block was renamed** or the section moved: the `block` or `path` no longer points at a multivariate.
2. **The index is past the end** of `variants`.
3. **The path skips the `lazy` wrapper**: a multivariate inside a variant's value is under `value.value`, not `value`.
4. **The value does not parse**: `parseDraftPointer` returns `null` for a stray `@`, an empty path segment (`a..b`), an index with more than four digits, or a preview parameter (`__at`, `__test`, `__campaign`) left inside the pointer. `parseVersion` lifts those out first.
5. **The host is not a preview host**: the link renders the release. Preview hosts come from the release metadata Studio writes, plus `createCMS({ preview: { hosts } })`.

## Previewing tests and campaigns

- `__test=<name>=on` shows the test's variants even at 0%, so a test can be checked before any visitor sees it. A name the saved block `experiments` does not have stays out.
- `__campaign=<name>=on` shows a campaign outside its window. `__at` moves the clock instead, so every campaign is checked at that moment.
- A bound in `__at` follows the same format as a campaign bound: an ISO 8601 date-time with an offset.

## What a preview never does

- It never reaches the page cache. Any request with a draft signal answers `Cache-Control: max-age=0, no-cache, must-revalidate`, `Vary: Cookie` and `noindex`.
- It never sends the visitor cookie. Studio is not a visitor.
- It does not change who is in a test for real visitors. Forcing is per request.
