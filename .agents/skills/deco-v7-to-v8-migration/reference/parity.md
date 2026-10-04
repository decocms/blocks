# Parity: approved v7 → v8 differences

Compare the migrated site with the v7 one with a parity harness (SSR HTML, hydrated DOM, JSON-LD, analytics calls, cache headers, third-party requests, pixels). Any difference fails unless the product owner approved it.

## How to encode an approval

Add it to an `approvedDifferences` list (e.g. in `parity/pages.json`), applied at compare time to both snapshots. Each rule names **one snapshot field**, **the cases it covers**, and **exactly what the new value must be**, so any other change to that field still fails. List the rules applied per case in the summary. Never ignore a field wholesale.

### Pending approval

A difference you've explained but the product owner hasn't approved yet still needs a state. Otherwise it's either a failing diff or an approval nobody signed. List it like an approval, with its reason, plus `"status": "pending"`:

- the default compare matches the entry, prints it as `PENDING` on every run and reports `PASS 0 diffs (N pending approval)`;
- `compare --strict` fails until each one is approved, which means deleting its `status` field. Run it in CI or before merging.

Never hide a pending entry: the compare summary and the PR list every one.

## Editor-form differences (v7 `meta.gen.json` → v8 `schema.gen.json`)

Compare each section's form, not just the content. Sort each difference into one of three causes before you approve or fix it.

**1. The v7 file was stale.** v7 committed `meta.gen.json`, and sections changed without anyone regenerating it. For each field, check the source's history after the file's last change (`git log <meta.gen.json commit>.. -- <section or shared type>`). If a field was added or removed there, v8 is right. Approve it with the commit as the reason.

**2. v7 heuristics v8 drops on purpose.** Approve these, don't "fix" them:
- **"Select from saved" on every list.** v7 offered it on every array. v8 offers it only where a saved block fits the field's type. Check that no content uses it, and whether the renderer could even resolve a saved block there.
- **A color picker from a substring.** v7 added the color widget whenever the type's *name* contained `Color`, even on a plain string-literal union such as a black/white choice. v8 keeps the dropdown. Existing values still validate.
- **Every file under `sections/` as a section.** v7 listed helper files (shared `types.ts`) as sections. v8 lists only what the block map declares.

**3. CLI fidelity bugs: fix them in the CLI, don't approve them.** If your `@decocms/blocks` predates these fixes, you'll see:
- a literal union's dropdown in TypeScript's internal order instead of the source order;
- `@format datetime` without the date-time picker;
- `Record<string, any>` offering "Select from saved" and every block type.

Upgrade to a release that includes them rather than approving the differences.

## Approved so far

storefront-tanstack (`5a5a4d4`):

- **JSON-LD in the first SSR HTML** for Lazy-wrapped sections (`ssr.jsonLd`): equal to the hydrated DOM's. Lazy wrappers now render on the server.
- **Extra product image requests** (`thirdPartyRequests`/`harMisses`) on flows that render more images server-side.
- **PLP "show more" page-2 `view_item_list` item indexes.**
- **Fixed cache headers** where v7 sent the wrong ones (the v7 QueryClient bug on `home@mobile`).
- Approved response headers ignored on both sides (`x-powered-by`; `b37a24b`).

blog-tanstack (`9e97455`):

- **Collector beacons recorded as analytics**: the built-in analytics block sends One Dollar Stats beacons straight to the collector instead of loading the SDK; decode them into the same view/event records, and compare `location.pathname` without the query string.
- **Real 404s** for unknown slugs and `/404` (v7 answered 200).

A native app with a v7 binding (bundled JSON, native rendering; `reference/native-apps.md`), pending product-owner approval:

- **Bundle and content unchanged.** No packed file and no saved block differs.
- **Editor forms.** The differences fall under the three causes above:
  - stale v7 `meta.gen.json`: a shared action type's new field across 15 sections, plus one removed CTA field;
  - list fields without "Select from saved";
  - two black/white text-color fields without the color picker;
  - `types.ts` no longer listed as a section.
