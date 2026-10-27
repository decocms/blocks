# Legacy type names

Saved content stores type names in `__resolveType`. Treat them like database columns: renaming one breaks the content that stores it.

## Resolved by the alias table (no change needed)

`LEGACY_ALIASES` in `@decocms/blocks/cli` maps these to built-ins. The site editor's screens look for them, so they keep working as saved:

| v7 name | Built-in |
|---|---|
| `website/pages/Page.tsx`, `$live/pages/LivePage.tsx` | `page` |
| `website/flags/multivariate.ts`, `website/flags/multivariate/section.ts` | `multivariate` (each plain variant `value` is wrapped in a `lazy` block on the way) |
| `website/matchers/always.ts` | `always` |
| `website/matchers/never.ts` | `never` |
| `website/loaders/redirect.ts` | `redirect` |

`website/loaders/secret.ts` has no built-in: secrets live in the deploy platform's secrets, and the script lists each one (`reference/script-steps.md`, step 2).

## Rewritten in content by the script

`RENAMED_TYPES` in `scripts/legacyNames.ts`; same props, same behaviour. This is the table in the docs' "Run the migration".

| v7 name | Saved as |
|---|---|
| `website/flags/multivariate/image.ts`, `website/flags/multivariate/message.ts`, `website/flags/multivariate/page.ts`, `$live/flags/multivariate.ts` | `website/flags/multivariate.ts` |
| `$live/matchers/MatchAlways.ts` | `website/matchers/always.ts` |
| `website/matchers/date.ts`, `$live/matchers/MatchDate.ts` | `date` |

## Everything else

Site types (`site/sections/Product/Shelf.tsx`) and app types (`shopify/loaders/ProductList.ts`) stay as saved: the block map registers each function under its v7 names only. A block under a short name too would be listed twice in the site editor's pickers, so the script writes no short names (PO 2026-10-15); add one only when new content needs it.
