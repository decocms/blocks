# Editor-form differences (v7 `meta.gen.json` → v8 `schema.gen.json`)

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

Encode the ones the product owner approves as rules, and keep the rest pending ([`parity.md`](./parity.md)).
