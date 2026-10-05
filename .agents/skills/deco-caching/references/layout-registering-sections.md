# Registering layout sections, and diagnosing misses

Layers 2 and 3 only apply to sections in the layout set. This file is about getting a section into (or out of) that set and confirming the cache is hit.

## Registration

In your site's `setup.ts`:

```typescript
import { registerLayoutSections } from "@decocms/blocks/cms";

registerLayoutSections([
  "site/sections/Header/Header.tsx",
  "site/sections/Footer/Footer.tsx",
  "site/sections/Theme/Theme.tsx",
  "site/sections/Miscellaneous/CookieConsent.tsx",
  "site/sections/Social/WhatsApp.tsx",
]);
```

To remove sections from the layout cache (e.g. a section is being demoted back to per-page resolution), use the matching `unregisterLayoutSections` export from the same module:

```typescript
import { unregisterLayoutSections } from "@decocms/blocks/cms";

unregisterLayoutSections(["site/sections/Social/WhatsApp.tsx"]);
```

### Auto-registration, and what a layout section may vary on

`applySectionConventions` (`@decocms/blocks/cms`) auto-registers any section that declares `export const layout = true`. To opt such a section back out, call `unregisterLayoutSections([...])` in `setup.ts` **after** `applySectionConventions` and before the first request.

Both layout caches key on the section plus the **device** (`mobile` / `tablet` / `desktop`, from the User-Agent): `layoutCacheKey` in `resolve.ts` and `layoutLoaderCacheKey` in `sectionLoaders.ts`. Device is the one signal the framework injects into every section, so a Header/Footer that renders differently per device is safe to layout-cache (before this, the first visitor's variant was served to everyone for the TTL). Anything else a layout varies on — a search param, a cookie, geo, sales channel, locale — is **not** in the key: such a section must stay out of the layout set, or the first visitor's variant is served to everyone for 5 minutes.

In dev, `registerSectionLoaders` warns when a request-dependent loader (`withDevice` / `withMobile` / `withSearchParam`, possibly via `compose`) is registered for a layout section. It warns even for the now-safe device case, because the `__requestDependent` flag doesn't say which signal the loader reads.


## Diagnosing Layout Cache Issues

### Symptom: Repeated `intelligent-search` calls in logs

```
[VTEX] ProductList: query="", count=100, collection="152", sort="price:desc"
[VTEX] ProductList: query="", count=100, collection="200", sort="price:desc"
[VTEX] ProductList: query="", count=20, collection="", sort="price:desc"
```

These come from Header product shelves being re-resolved on every navigation.

### Fix Checklist

1. Ensure `registerLayoutSections` includes the Header section key
2. Verify the block reference chain resolves correctly (check `.deco/blocks/Header*.json`)
3. Confirm `isLayoutSection` returns `true` for the section key
4. Add logging to verify cache hits: `console.log("[CMS] Layout cache HIT:", layoutKey)`


## Common errors during implementation

### Error: `isLayoutSection is not a function`

`isLayoutSection` is already exported from `@decocms/blocks/cms` (`packages/blocks/src/cms/index.ts`). If it is missing, check the installed `@decocms/blocks` version (or linked checkout) and that you import from `@decocms/blocks/cms`, not a deep or `/cms/client` path.

### Error: Layout sections cached but still showing stale content

The 5-minute TTL means layout sections won't reflect CMS changes for up to 5 minutes in dev. Restart the dev server to clear in-memory caches.

### Error: Block reference chain not found

If `isRawSectionLayout` returns `null` for a block like `"Header - 01"`, the block reference in `.deco/blocks/` may not resolve to the layout section. Check:

```bash
cat '.deco/blocks/Header - 01.json' | python3 -c "import sys,json; print(json.load(sys.stdin).get('__resolveType','?'))"
```
