---
name: deco-storefront-performance
description: "Server and render performance for storefronts on @decocms/blocks 8 (mostly @decocms/tanstack on Cloudflare Workers; @decocms/nextjs where noted), indexed by symptom. Covers N+1 and duplicate upstream calls in block functions (the client's per-request memo, currentClient(), counting calls with createInstrumentedFetch's metric or a logging fetch), trimming schema.org Product graphs before they reach the HTML, render location (the built-in lazy block, streamed vs awaited blocks, the cost of a large Redirects block), hydration mismatches and flashes, CLS from third-party scripts, instant variant switching, scroll and navigation feedback, reading Chrome traces, and Worker memory (measuring per deploy, large tables out of the bundle, streaming big proxied bodies). Use when TTFB is slow but the HTML is small, the HTML is several MB, one VTEX operation runs many times per page, React logs a hydration error, a section flashes or shifts, a variant click refetches the page, or a Worker hits its 128 MB limit."
---

# Storefront performance on v8

You have a v8 storefront that is slow or unstable in a specific way. This skill is
organised by symptom. Find the symptom below and load the one reference it names.

It is about server work, payload and render behaviour. It does not cover:

- **Edge and page caching** (`pageCache`, cache keys, hit rate, upstream caches): see
  the skill `deco-storefront-caching`.
- **How blocks, sections and `lazy` are written**: see `deco-site-authoring`.
- **Wiring the TanStack site** (worker entry, page route, server functions): see
  `deco-tanstack-site`. For Next.js, `deco-nextjs-site`.
- **The thin clients** (`createVtexClient` and its options): see `deco-apps`.
- **Generic browser-side craft** (Core Web Vitals, JS budgets, HTML size, PageSpeed
  scoring): the decocms/skills skills `improving-web-vitals-tanstack`,
  `client-js-budget`, `html-size-optimizer` and `pagespeed-score-model`.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/render-location.md`](./references/render-location.md) | TTFB is seconds but the HTML is small; a page resolves data it never shows; you are not sure which block is slow; the site has thousands of redirects |
| [`references/loaders-n-plus-1.md`](./references/loaders-n-plus-1.md) | One upstream call per product in a block function; SSR gets slower with shelf size; VTEX answers 429 |
| [`references/request-dedupe.md`](./references/request-dedupe.md) | The same upstream operation runs several times for one page; two sections fetch the same product; you want to count calls before and after |
| [`references/payload-trim.md`](./references/payload-trim.md) | The HTML or a `/_serverFn/` response is several MB; the HTML is full of `UnitPriceSpecification`; JSON-LD is huge |
| [`references/hydration.md`](./references/hydration.md) | React logs a hydration mismatch; a section shows server markup but never becomes interactive; a section flashes on load |
| [`references/cls-third-party.md`](./references/cls-third-party.md) | CLS is high; a widget, seal or chat script pushes content after load |
| [`references/navigation-ux.md`](./references/navigation-ux.md) | A variant click takes >500 ms or refetches the page; forward navigation keeps the old scroll position; clicks give no feedback; hover prefetch loads the upstream |
| [`references/trace-reading.md`](./references/trace-reading.md) | You need to find which element shifted, why the screen went blank, or where a slow navigation spends its time; local numbers disagree with production |
| [`references/worker-memory.md`](./references/worker-memory.md) | The Worker logs "exceeded memory limit" or its memory P90 grew after a deploy; a proxied sitemap or feed is large |

## First, split the cost

Two numbers tell you which half of the skill you need:

```bash
curl -s -o /dev/null -A "Mozilla/5.0 Chrome/120" "$URL" \
  -w 'bytes %{size_download}  ttfb %{time_starttransfer}s  total %{time_total}s\n'
```

- **Small body, long wait**: the server did work. Go to `render-location.md`,
  then `loaders-n-plus-1.md` and `request-dedupe.md`. Trimming payload will not move
  this number. One product page measured 29 KB on the wire and 4.6 s of wait.
- **Large body, short wait**: payload. Go to `payload-trim.md`.
- **Fast server, bad experience in the browser** (flash, shift, slow click): go to
  `hydration.md`, `cls-third-party.md`, `navigation-ux.md` and `trace-reading.md`.

Measure the same URL two or three times. If one run is 0.2 s and the next is 3.6 s,
that is a cold isolate or a cache miss, not the page. Read `deco-storefront-caching`
before you optimise anything.

## How v8 runs a page, in one paragraph

The worker (`createDecoWorker`) checks the CMS redirects on every `GET` that is not an
asset or a server-function call, then calls the site's `pageCache` if it has one, then
renders. The page route of the example app (`examples/tanstack-worker-smoke`; wiring in
`deco-tanstack-site`) asks
one client (`contentClient(cms, request)`) for the page with `{ run: false }`, starts
one promise per section block with `client.resolve(block)`, awaits only the SEO block,
and streams the sections through `<Suspense>`/`<Await>`. A client runs each block
function once per distinct input, so equal blocks in one request share a result. Nothing
is shared between requests: the client never caches. A client-side navigation calls
the page server function (a `/_serverFn/` request), which does the same work.

The references build on that model. When a fix depends on it, they say so.

## Rules for this skill

- **Measure, then attribute.** Count calls and time blocks before you change code.
  Guessing from payload size pointed at the wrong section three times on one site.
- **Do not move above-the-fold or crawler-relevant content to the client to win a
  number.** The goal is to stop work that is thrown away, not to hide work users need.
- **Prove a fix with a control.** Same URL, same device, same cache state, before and
  after. A single before/after pair on a busy day is a guess.
- **Copy a block result before you change it.** Equal blocks in one request share the
  same object. Mutating one in place changes the others.
