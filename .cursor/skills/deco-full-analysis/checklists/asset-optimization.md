# Asset Optimization Checklist

17 learnings from real Deco sites. Check these during analysis.

## Third-Party Scripts

### 1. On-Demand Script Loading
**Check**: Are heavy scripts loaded on page load?

```typescript
// Bad: Loads immediately
<script src="https://chat-widget.com/bundle.js" />

// Good: Load on interaction
function ChatButton() {
  const [loaded, setLoaded] = useState(false);
  
  const loadChat = () => {
    if (!loaded) {
      const script = document.createElement('script');
      script.src = "https://chat-widget.com/bundle.js";
      document.body.appendChild(script);
      setLoaded(true);
    }
  };
  
  return <button onClick={loadChat}>Chat</button>;
}
```

### 2. Route-Specific Script Injection
**Check**: Do scripts load on pages where they're not used?

```typescript
// Good: Only load on relevant pages (ctx.url was Fresh's per-request context;
// use the request URL directly — e.g. Next's `usePathname()`/route segment, or
// TanStack's `useRouterState({ select: s => s.location.pathname })`)
const isCheckout = pathname.startsWith('/checkout');
const isPDP = pathname.includes('/p');

return (
  <>
    {isCheckout && <PaymentScript />}
    {isPDP && <ReviewScript />}
  </>
);
```

### 3. Script Localization
**Check**: Are external scripts hosted locally?
- Localize frequently used scripts to `public/` (Fresh's `/static` convention
  doesn't apply — both Next.js and Vite/TanStack Start serve the `public/`
  directory at the site root)
- Improves reliability and performance
- Works offline

```typescript
// Before: External
<script src="https://unpkg.com/htmx.org@1.9.10" />

// After: Local — file at public/htmx-1.9.10.js
<script src="/htmx-1.9.10.js" />
```

(HTMX itself is also no longer relevant — these sites are React, not HTMX — but
the localization principle applies to any third-party script.)

### 4. GTM Implementation
**Check**: Does GTM have noscript fallback?

```html
<!-- Head -->
<script>(function(w,d,s,l,i){...})(window,document,'script','dataLayer','GTM-XXX');</script>

<!-- Body (required) -->
<noscript>
  <iframe src="https://www.googletagmanager.com/ns.html?id=GTM-XXX" />
</noscript>
```

### 5. Third-Party Widget Removal
**Check**: Are there unused third-party widgets?
- Audit PDP for review widgets that can be lazy-loaded
- Remove chat widgets from pages where not needed
- Defer non-critical analytics

## Section Optimization

### 6. Lazy Section Loading
**Check**: Are heavy below-fold sections lazy?

```json
{
  "__resolveType": "website/sections/Rendering/Lazy.tsx",
  "section": { "__resolveType": "site/sections/Product/Reviews.tsx" }
}
```

Best candidates for lazy loading:
- Product shelves
- Reviews
- Similar products
- FAQ sections
- Instagram feeds

### 7. Skeleton/Fallback Pattern
**Check**: Do async sections have loading states?

```typescript
export function LoadingFallback() {
  return (
    <div class="animate-pulse">
      <div class="h-8 bg-gray-200 rounded w-1/3 mb-4" />
      <div class="grid grid-cols-4 gap-4">
        {[...Array(4)].map(() => (
          <div class="h-64 bg-gray-200 rounded" />
        ))}
      </div>
    </div>
  );
}
```

### 8. Video Section Handling
**Check**: Are video sections wrapped in Lazy/Deferred?
- Native video or iframes should NOT be lazy wrapped
- Causes interaction breakage
- Only lazy wrap if explicitly needed

## Block Architecture

### 9. Block Flattening
**Check**: Are there unnecessary PageInclude wrappers?

The `$`-prefix shorthand (`"$Header-Block"`) is stale — verified against
`packages/live/src/cms/resolve.ts`: named-block references now resolve by
using the block's plain name directly as `__resolveType` (e.g.
`{"__resolveType": "Header - 01"}` resolves to whatever block is named
`"Header - 01"` in the CMS content — no `$` prefix). Whether `website/sections/PageInclude.tsx`
itself still exists is **not verified** here — it would come from `@decocms/apps`
(a separate repo not vendored in this monorepo), not from `@decocms/live`.

```json
// Bad: Extra resolution overhead
{
  "__resolveType": "website/sections/PageInclude.tsx",
  "page": { "__resolveType": "Header - 01" }
}

// Good: Direct reference to the named block
{
  "__resolveType": "Header - 01"
}
```

## Migration

### 10. Standard Library Migration
**Check**: Are there `deco-sites/std` or `apps/website` imports?

Both of these are stale now, not just `deco-sites/std`. Verified against
`packages/cli/scripts/migrate/templates/ui-components.ts` and
`.agents/skills/deco-to-tanstack-migration/references/commerce/README.md`: UI
components (`Image`, `Picture`, `Seo`, `Theme`, etc.) are **site-local** —
generated into `src/components/ui/` — not imported from an `apps/` package path.

```typescript
// Bad: Legacy (Fresh/Deno CDN import paths)
import { Image } from "deco-sites/std/components/Image.tsx";
import { Image } from "apps/website/components/Image.tsx";

// Good: Modern — site-local wrapper (re-exports from @decocms/apps/commerce/components/Image)
import { Image } from "~/components/ui/Image";
```

Audit all imports and replace:
- `deco-sites/std` / `apps/website/components/*` → `~/components/ui/*` (site-local)
- `apps/commerce/types.ts`, `apps/commerce/utils/*` → `@decocms/apps/commerce/*` (npm package, still shared)

## Layout Stability

### 11. Aspect Ratio Reservation
**Check**: Do images/videos cause CLS?

```tsx
// Good: Reserve space
<div class="aspect-video relative">
  <Image class="absolute inset-0 w-full h-full object-cover" />
</div>
```

## Security

### 12. CSP Hardening
**Check**: Are CSP headers configured?

No more `_middleware.ts` (that's a Fresh routing convention). Verified against
`packages/tanstack/src/sdk/workerEntry.ts` and `packages/live/src/sdk/csp.ts`:

- **TanStack Start / Cloudflare Workers sites**: `createDecoWorkerEntry()` takes a
  `csp?: string[] | false` option — an array of directive strings joined with `"; "`.
  Note this sets `Content-Security-Policy-**Report-Only**`, not an enforcing
  `Content-Security-Policy` header (the framework's own default security headers
  don't include CSP at all — "it's site-specific", per that file's comment).
  Separately, `setCSPHeaders()` in `@decocms/live/sdk/csp` sets `frame-ancestors`
  (only) so the Deco admin can iframe-embed the storefront for live preview —
  that's a different, narrower concern than general script/asset hardening.
- **Next.js sites**: no built-in CSP helper found in `@decocms/next`. Use Next's
  standard `middleware.ts` at the project root, or `headers()` in `next.config.js`.

```typescript
// TanStack: passed to createDecoWorkerEntry({ csp: [...] })
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
  "worker-src 'self'",
  "frame-ancestors 'self'",
];
// → becomes the Content-Security-Policy-Report-Only header, not an enforcing one.
// If you need it enforcing, that's a gap to raise with the site, not something
// the current csp option gives you.
```

### 13. Service Worker Strategy
**Check**: Is Service Worker strategy optimal?

```typescript
// Avoid: NetworkOnly as default (negates caching)
defaultStrategy: "NetworkOnly"

// Better: CacheFirst or StaleWhileRevalidate
defaultStrategy: "CacheFirst"
```

## Build Tooling

### 14. Deno Native Optimization — no longer applicable
There is no `deno.json` and no Deno runtime on TanStack/Next sites — they're
standard npm/pnpm/bun projects built with Vite (TanStack) or webpack/Turbopack
(Next), so `node_modules` always exists and `nodeModulesDir` has no equivalent
knob to check. Drop this item; if there's a comparable "unnecessary
dependency-resolution overhead" concern for Vite or Next specifically, it wasn't
verified here and shouldn't be guessed at.

### 15. Relative Path Invocation
**Check**: Are loaders using absolute URLs?

The specific `/live/invoke/...` endpoint from item 15's example is **not verified**
to exist in the current runtime — a search of `@decocms/live`, `@decocms/admin`,
`@decocms/next`, and `@decocms/tanstack` found no `live/invoke` route. Server-side
data fetching in the current architecture goes through section loaders /
`COMMERCE_LOADERS` function calls (see `cache-strategy.md`), not an HTTP invoke
endpoint called from within another loader. The underlying principle — avoid
absolute same-origin URLs for server-to-server or client-to-server calls within
the app — is still generically good advice; just don't cite `/live/invoke` as if
it's a real current endpoint without checking the specific site.

## Quick Audit Commands

```bash
# Find stale legacy import paths
grep -rn "deco-sites/std\|from \"apps/" src/

# Find third-party scripts
grep -rn '<script src="http' src/sections/ src/components/

# Find sections without LoadingFallback
for f in src/sections/**/*.tsx; do
  grep -q "LoadingFallback" "$f" || echo "Missing fallback: $f"
done

# Check CSP / security header config — TanStack: the createDecoWorkerEntry() call
# (commonly in the site's worker/server entry file); Next: middleware.ts / next.config.js
grep -rn "csp\|Content-Security-Policy" src/ next.config.* middleware.ts 2>/dev/null
```

## Asset Audit Table

Add this to AGENTS.md:

```markdown
## Third-Party Scripts

| Script | Pages | Load Strategy | Action |
|--------|-------|---------------|--------|
| GTM | All | Head | ✅ OK |
| Chat Widget | All | Eager | 🔴 Make lazy |
| Reviews | PDP | Eager | 🟡 Consider lazy |
| Payment | Checkout | Conditional | ✅ OK |
```
