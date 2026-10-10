# Parity: approved v7 → v8 differences

Compare the migrated site with the v7 one with a parity harness (SSR HTML, hydrated DOM, JSON-LD, analytics calls, cache headers, third-party requests, pixels). Any difference fails unless the product owner approved it.

## How to encode an approval

Add it to an `approvedDifferences` list (e.g. in `parity/pages.json`), applied at compare time to both snapshots. Each rule names **one snapshot field**, **the cases it covers**, and **exactly what the new value must be**, so any other change to that field still fails. List the rules applied per case in the summary. Never ignore a field wholesale.

### Pending approval

A difference you've explained but the product owner hasn't approved yet still needs a state. Otherwise it's either a failing diff or an approval nobody signed. List it like an approval, with its reason, plus `"status": "pending"`:

- the default compare matches the entry and prints the case as `PENDING` on every run. Report three counts, ok, PENDING and DIFF; never fold PENDING cases into "N/M identical" in the summary, the README or the PR;
- `compare --strict` fails until each one is approved, which means deleting its `status` field. Run it in CI or before merging.

Never hide a pending entry: the compare summary and the PR list every one.

## Running it

- **Record what v7 actually does, even when it is broken.** A v7 page that is already wrong (one storefront's product listing showed "12 of 0 results" on every category and search page, live too, because its listing loader never got the page URL) is still the baseline. Record it as it is, mark the flows it makes impossible (filter, show more, listing to product) as blocked in the manifest with the reason, and compare them only once both sides can run. The v8 page that works is a product change: list it as pending with screenshots of both.
- **v7's catch-all answers 200.** A `/*` page (a category catch-all) renders for every unknown path, `/products/<unknown>` and `/sitemap.xml` included, with status 200 and no sitemap. Pin that in cases (status, body type) instead of assuming real 404s or a sitemap; turning them into 404s is a product change to list, not a parity fix.
- **No analytics SDK?** Record the site's own event bus (`window.DECO.events.dispatch`) from an init script instead of a third-party stub, so `view_item_list`, `select_item`, `add_to_cart` and `search` are compared.
- **Settle before clicking a card scrolled into view.** An IntersectionObserver `view` event can race a click that navigates: scroll the element into view, settle, then click, or the event lands on either page from run to run.
- **`parity:build` on v7 regenerates the v7 codegen** (`.deco/sections.gen.ts` and friends) with a different order: revert those files before committing the harness.

- **Build against what ships.** Do the final compare on a build from the committed lockfile, not a linked local checkout: a published package can differ (source vs compiled output, older CLI).
- **ISR and prerendered routes.** Pages prerendered at build time with `revalidate` were stale when the baseline recorded them. Compare a build older than the longest `revalidate`, or those cases differ only in `x-nextjs-cache`/`x-nextjs-prerender`.
- **Flakes.** Rerun a single failing case (`--only <case>`) before treating it as a regression, and avoid running two harnesses on one machine at once: font rasterization under load produced one-off weight diffs. Record each full run's flake count and which cases flipped; a count that grows between runs is a determinism regression to document or fix, not noise. A case that fails again on rerun isn't a flake: look up its differing pixels in every earlier run, v7 self-compares included, with each run's value. If v7 against its own baseline flipped the same pixel, write that evidence and the rate on each side into a pending pixel rule (a rectangle that covers only those pixels), not a mask; if only v8 flips it, fix it or list it as pending. Never report N/N on a run where it failed.
- **A `harMisses` flake from the screenshot itself.** Chromium's full-page capture can re-run `<picture>` source selection against a transient narrow frame, so a desktop capture sometimes requests (and the harness aborts) the mobile `<source>` images, on v7 and v8 alike. Key `harMisses` by the full URL: an image proxy (`decoims.com/image?src=…`) names the image in the query, so origin + path lumps every image of the page into one entry and a drop list hides them all. Drop only the named URLs, on both sides, for those cases, and give the list a `status: "pending"` that the summary prints and `--strict` fails on whenever it changed a result: it is a suppression the product owner sees, not harness housekeeping.
- **Re-run the v7 self-compares after every harness change.** Two v7-vs-v7 runs at 0 diffs prove the harness as it was then; a later change to compare, capture or the manifest needs two new ones (`--strict --strict-upstream`, pending rules off) before a v8 number means anything. After a snapshot format change, re-capture the baseline from its fixtures (pass 2 of `record`, no live traffic) on the v7 build and check it equals the old one apart from that field.
- **Wait loops that find themselves.** A `pgrep -f '<pattern>'` (or `pkill -f`) "is a heavy job running" check matches the shell running the loop, since the pattern is in its command line: the loop never ends, holds up every agent that runs the same check, and `pkill` kills your own shell. Wait on a PID (`while kill -0 <pid>`) or bracket a character (`pgrep -f '[r]un.mjs'`).
- **Pin the Workers `request.cf` object.** A local Workers runtime (Miniflare/wrangler) fills `request.cf` from a cache file fetched for the machine's network location (`node_modules/.mf/cf.json`), once per checkout. Two checkouts fetched at different times can disagree (region, city, colo), and anything keyed on the region (a cache segment, regional prices) differs. Copy one checkout's file into the other before recording, and record and compare on the same ports: URLs built from the origin can carry the port.
- **A bad baseline is re-recorded, never masked.** If the v7 baseline itself captured a rendering flake (an icon laid out but not painted), re-record that case from the v7 site (`record --only <case>`) instead of adding a pixel-ignore rect. The re-record also refreshes that case's upstream fixtures live, so its page can change (prices, stock, page height); run a full compare afterwards.
- **Fix in code what code can fix, then prove it on every page type.** Before asking for approval, try removing a pending difference in site code; then run the full compare, not just the cases the rule named. A popup gated on the footer's position fixed the home page cases and broke the product page ones (`gotchas.md`, Rendering), so that rule stayed pending.
- **A fixed upstream request gets a pending baseline.** When v8 fixes a v7 bug in what it asks upstream (a listing loader that now gets the page URL), its requests were never recorded and miss in replay. Don't re-record the v7 baseline to hide it, and don't leave them as nondeterministic diffs called "now working" (in one run the section was missing entirely). Record what v7's fixtures lack once from live upstream, at the fixed time, into a store and HAR used only for those cases and only on a miss in v7's; capture v8 from them in replay; compare those cases against that pinned capture, reported PENDING (never ok), with the v7-vs-v8 diffs beside it. A later regression there still fails.
- **A replay miss must not drop a section.** A section whose loader throws on an upstream error vanished from the page (header straight to the footer), which is also what a real upstream outage would do in production. Make the loader return the empty state v7 showed (breadcrumb, filters, "0 results"), log the error, and check that path once with a deliberate miss.
- **Check claims about v7 against the baseline.** "v7 sent `X-Frame-Options`" came from a v7 code comment; the recorded headers had neither it nor `frame-ancestors`. Keep parity and list the hardening (`frame-ancestors` with the Studio origins) as a product-owner decision.
- **A harness without pending support.** If the copied harness only knows approvals, add the `status: "pending"` state (and `--strict`) before encoding anything, so no explained difference is ever written as an approval.
- **Reduced motion hides dead sections.** Capturing with `reducedMotion: reduce` shows content a scroll-reveal animation would keep invisible, so a section that never hydrates still matches. Load the main page types once without it, in a plain browser, and compare against the live v7 site.
- **Not covered by pixels.** Name what the cases don't exercise (draft rendering through the pointer, coupons, region pricing, signed-in shoppers, device-only variants on per-request pages, hosted releases) in the PR so it gets a manual check. A replaying harness also can't see latency: a page that now waits on an upstream call before hydrating, or a draft check that no longer lets the edge cache serve, passes every compare. Review those code paths by hand.

## Editor-form differences (v7 `meta.gen.json` → v8 `schema.gen.json`)

Compare each section's form, not just the content. Sort each difference into one of three causes before you approve or fix it.

**1. The v7 file was stale.** v7 committed `meta.gen.json`, and sections changed without anyone regenerating it. For each field, check the source's history after the file's last change (`git log <meta.gen.json commit>.. -- <section or shared type>`). If a field was added or removed there, v8 is right. Approve it with the commit as the reason.

**2. v7 heuristics v8 drops on purpose.** Approve these, don't "fix" them:
- **"Select from saved" on every list.** v7 offered it on every array. v8 offers it only where a saved block fits the field's type. Check that no content uses it, and whether the renderer could even resolve a saved block there.
- **Every file under `sections/` as a section.** v7 listed helper files (shared `types.ts`) as sections. v8 lists only what the block map declares.
- **Dynamic option pickers.** v7's `@format dynamic-options` fields ran a site loader through `/deco/invoke` to suggest values as the editor typed. The v8 site editor never runs site code, so they become text fields (`/next/schema`). Make sure the field still accepts what an editor would type (a bare ID, a plain place name), update copy that promises suggestions (grep each such field's `@description` for search wording in the site's language: search, type part of the name, pick from the list), and list each field, with its new copy, for approval.
- **Page form order and labels.** A site page type that `extends Route` and adds `seo`/`sections` lists its own fields first and labels `seo` as "Seo". Redeclare `name` and `path` (with their `@title`) before them and give `seo` an explicit `@title SEO` to keep v7's form.
- **The rich-text widget from a substring.** v7 gave the rich-text editor to any type whose name contained `RichText` (`PromoRichText`). v8 matches the alias name as a whole word. When editors rely on the toolbar, keep it with `/** @format rich-text */` on the alias rather than approving its loss.

**A color picker from a substring: keep it, don't approve its loss.** v7 added the color widget whenever the type's *name* contained `Color`, even on a string-literal union such as a black/white choice. v8 doesn't guess from names: put `/** @format color */` on the alias (`type TextColor = "black" | "white"`) or on the field, and `deco schema` writes the same `format: "color"` v7 did, with the select's values kept (`/next/schema#widgets`).

**Product pickers gain "Inline data".** A field typed as loader data (`Product[] | null`) offers the loaders the block map registers plus an inline-data option v7 didn't have; the loaders are listed in the block map's order. Register the loaders v7 offered (vendor them if needed) in v7's order, and list the inline option for approval.

**3. CLI fidelity bugs: fix them in the CLI, don't approve them.** If your `@decocms/blocks` predates these fixes, you'll see:
- a literal union's dropdown in TypeScript's internal order instead of the source order;
- `@format datetime` without the date-time picker;
- `Record<string, any>` offering "Select from saved" and every block type.

Upgrade to a release that includes them rather than approving the differences.

**Literal order depends on the v7 generator.** Check the site's own v7 `meta.gen.json` before calling an order a bug. Deno-era generators wrote a union's values in source order. `@decocms/blocks-cli` 7 (TanStack and Next.js sites) took the TypeScript checker's order, which is source order unless the same literals already appeared in another type (`'both' | 'desktop' | 'mobile'` came out `desktop, mobile, both`). On such a site the source-order fix reorders those dropdowns relative to v7. That's a stable, intended order, but it's still an editor-visible change, so list it for approval.

## Approved so far

**Approvals are per site.** The lists below are what each site's product owner signed. When a harness is copied from another site, copy its mechanics and leave `approvedDifferences` and `ignoreHeaders` empty: the same difference becomes `pending` on the new site until its own product owner approves it. Say so in the harness README.

storefront-tanstack (`5a5a4d4`):

- **JSON-LD in the first SSR HTML** for Lazy-wrapped sections (`ssr.jsonLd`): equal to the hydrated DOM's. v8 has no async rendering: the script unwraps Lazy wrappers to their sections, which render on the server.
- **Extra product image requests** (`thirdPartyRequests`/`harMisses`) on flows that render more images server-side.
- **PLP "show more" page-2 `view_item_list` item indexes.**
- **Fixed cache headers** where v7 sent the wrong ones (the v7 QueryClient bug on `home@mobile`).
- Approved response headers ignored on both sides (`x-powered-by`; `b37a24b`).

blog-tanstack (`9e97455`):

- **Collector beacons recorded as analytics**: `AnalyticsScript` sends One Dollar Stats beacons straight to the collector instead of loading the SDK; decode them into the same view/event records, and compare `location.pathname` without the query string.
- **Real 404s** for unknown slugs and `/404` (v7 answered 200).

A native app with a v7 binding (bundled JSON, native rendering; `reference/native-apps.md`), pending product-owner approval:

- **Bundle and content unchanged.** No packed file and no saved block differs.
- **Editor forms.** The differences fall under the three causes above:
  - stale v7 `meta.gen.json`: a shared action type's new field across 15 sections, plus one removed CTA field;
  - list fields without "Select from saved";
  - two black/white text-color fields without the color picker: not approved (the product owner keeps the picker); annotate their alias `@format color`;
  - `types.ts` no longer listed as a section.
