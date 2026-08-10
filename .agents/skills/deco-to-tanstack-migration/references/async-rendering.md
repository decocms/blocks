# Async Rendering: Architecture & Site Implementation

## Part 1: Architecture

Internal documentation for the async section rendering system in `@decocms/start`.

### When to Use This Reference

- Debugging why a section is or isn't being deferred
- Understanding the full request flow from CMS resolution to on-scroll loading
- Extending the async rendering system (new cache tiers, new deferral strategies)
- Fixing issues with deferred section data resolution
- Understanding how bot detection and SEO safety work
- Working on `@decocms/start` framework code

---

### Problem Solved

TanStack Start serializes all `loaderData` as JSON in a `<script>` tag for client-side hydration. When a CMS page has 20+ sections with commerce data, the HTML payload becomes enormous (8+ MB on some pages). The root cause: `resolveDecoPage` fully resolves ALL sections, and TanStack Start embeds everything.

### Architecture Overview

```
Request → resolveDecoPage()
  ├─ resolveSectionsList()     → unwrap flags/blocks to get raw section array
  ├─ shouldDeferSection()      → classify each section as eager or deferred
  │   ├─ Eager: resolveRawSection() → full CMS + commerce resolution
  │   └─ Deferred: resolveSectionShallow() → component key + raw CMS props only
  ├─ runSectionLoaders()       → enrich eager sections (server loaders)
  └─ Return { resolvedSections, deferredSections }

Client render → DecoPageRenderer
  ├─ mergeSections()           → interleave eager + deferred by original index
  ├─ Eager: <Suspense><LazyComponent .../></Suspense>
  └─ Deferred: <DeferredSectionWrapper>
       ├─ preloadSectionModule() → get LoadingFallback early
       ├─ Render skeleton (custom LoadingFallback or generic)
       ├─ IntersectionObserver(rootMargin: 300px)
       └─ On intersect: loadDeferredSection serverFn
            ├─ resolveDeferredSection() → resolve __resolveType refs in rawProps
            ├─ runSingleSectionLoader() → enrich with server loader
            └─ Return ResolvedSection → render real component with fade-in
```

---

### Deferral Strategy: CMS Lazy.tsx as Source of Truth

#### How it works now (respectCmsLazy)

The deferral decision is driven by **CMS editor choices**, not a global index threshold:

1. **`respectCmsLazy: true`** (default) — a section is deferred if and only if it's wrapped in `website/sections/Rendering/Lazy.tsx` in the CMS page JSON
2. **`foldThreshold`** (default `Infinity`) — fallback for sections NOT wrapped in Lazy; with default `Infinity`, non-wrapped sections are always eager
3. **`alwaysEager`** — section keys that override all deferral (Header, Footer, Theme, etc.)

#### Why this approach

The previous `foldThreshold` approach deferred sections by index position, ignoring editor intent. This caused:
- Sections that editors wanted eager getting deferred
- No control per-page (threshold was global)
- Homepage with 12 sections marked Lazy in CMS showing 0 deferred

Now editors control deferral by wrapping sections in `Lazy.tsx` in the CMS admin, and the framework respects that.

#### `isCmsDeferralWrapped(section)` in `resolve.ts`

Detects whether a section is wrapped in `website/sections/Rendering/Lazy.tsx`, either:
- Directly: `section.__resolveType === "website/sections/Rendering/Lazy.tsx"`
- Via named block: `section.__resolveType` references a block whose `__resolveType` is `"website/sections/Rendering/Lazy.tsx"`

#### `shouldDeferSection(section, flatIndex, cfg, isBotReq)`

Decision logic — the admin ⚡ (CMS Lazy/Deferred wrapper) is checked FIRST and
overrides every code-level flag:

```
1. Bot request? → EAGER (SEO safety — full SSR even for ⚡ sections)
2. No __resolveType? → EAGER (can't classify)
3. resolveFinalSectionKey() → walk block refs + Lazy wrappers + flags
4. respectCmsLazy && isCmsDeferralWrapped(section)? → DEFER  ← source of truth
── below: opt-in only; never overrides the admin; inert when foldThreshold = Infinity ──
5. isLayoutSection()? → EAGER
6. isNeverDeferSection()? → EAGER
7. flatIndex < foldThreshold && (isEagerSection() || alwaysEager.has())? → EAGER
8. flatIndex >= foldThreshold? → DEFER (off by default; Infinity)
9. Otherwise → EAGER
```

---

### Files and Their Roles

| File | Layer | Role |
|------|-------|------|
| `src/cms/resolve.ts` | Server | Types, config, eager/deferred split, CMS Lazy detection, shallow resolution, full deferred resolution |
| `src/cms/sectionLoaders.ts` | Server | Section loader registry, layout cache, SWR cacheable sections, `runSingleSectionLoader` |
| `src/cms/registry.ts` | Shared | Section component registry, `preloadSectionModule` for early LoadingFallback |
| `src/routes/cmsRoute.ts` | Server | `loadCmsPage`, `loadCmsHomePage`, `loadDeferredSection` server functions |
| `src/hooks/DecoPageRenderer.tsx` | Client | Merge, render eager/deferred, `DeferredSectionWrapper`, dev warnings |
| `src/cms/index.ts` | Barrel | Re-exports all public types and functions |
| `src/routes/index.ts` | Barrel | Re-exports route helpers including `loadDeferredSection` |

---

### Server-Side: Eager/Deferred Split

#### Entry point: `resolveDecoPage()` in `resolve.ts`

```
resolveDecoPage(targetPath, matcherCtx)
  1. findPageByPath(targetPath) → { page, params }
  2. Get raw sections array:
     - If page.sections is Array → use directly
     - If page.sections is wrapped (multivariate flag, block ref) → resolveSectionsList()
  3. For each raw section:
     - If shouldDeferSection() → resolveSectionShallow() → DeferredSection
     - Else → resolveRawSection() (full resolution) → ResolvedSection[]
  4. Return { resolvedSections, deferredSections }
```

#### `resolveSectionsList(value, rctx, depth)`

Resolves **only the outer wrapper** around the sections array. Handles multivariate flags, named block references, and `resolved` type wrappers. Extracts the raw section array WITHOUT resolving individual section commerce loaders.

#### `resolveFinalSectionKey(section)`

Walks block reference chain and unwraps `Lazy` wrappers to find the final registered section component key:

```
"Header - 01" (named block)
  → { __resolveType: "website/sections/Rendering/Lazy.tsx", section: {...} }
    → { __resolveType: "site/sections/Header/Header.tsx", ...props }
```

Returns `"site/sections/Header/Header.tsx"`, checked against `alwaysEager` and `isLayoutSection`.

#### `resolveSectionShallow(section)`

Synchronously follows block refs and unwraps Lazy to extract `component` (final key) and `rawProps` (CMS props as-is). No API calls, no async.

#### `resolveDeferredSection(component, rawProps, pagePath, matcherCtx)`

Called when client requests a deferred section. Runs full resolution:
1. `resolveProps(rawProps, rctx)` — resolves all nested `__resolveType` references
2. `normalizeNestedSections(resolvedProps)` — converts nested sections to `{ Component, props }`
3. Returns `ResolvedSection` ready for `runSingleSectionLoader`

---

### Server-Side: Section Caching

#### Three cache tiers in `sectionLoaders.ts`

**Tier 1: Layout sections** (Header, Footer, Theme)
- 5-minute TTL, in-flight dedup, registered via `registerLayoutSections`

**Tier 2: Cacheable sections** (ProductShelf, FAQ)
- Configurable TTL via `registerCacheableSections`, SWR semantics, LRU eviction at 200 entries
- Cache key: `component::djb2Hash(JSON.stringify(props))`

**Tier 3: Regular sections** — No caching, always fresh.

---

### Client-Side: DeferredSectionWrapper

#### Lifecycle

```
1. Mount (stableKey = pagePath + component + index)
   ├─ preloadSectionModule(component) → extract LoadingFallback
   └─ Render skeleton (custom or generic DefaultSectionFallback)

2. IntersectionObserver (rootMargin: "300px")
   └─ On intersect (once):
       ├─ loadDeferredSection serverFn
       ├─ On success: render <LazyComponent .../> with fade-in
       └─ On error: render ErrorFallback or null

3. SPA navigation: stableKey changes → reset state (triggered, section, error)
```

#### Key: stableKey for SPA navigation

`DeferredSectionWrapper` uses `pagePath + component + index` as a stable key. When the route changes, this key changes, forcing React to remount the wrapper and reset all internal state. This prevents deferred sections from a previous page being "stuck" in a triggered state.

---

### Bot Detection (SEO Safety)

`isBot(userAgent)` regex detects search engine crawlers. When detected, ALL sections are resolved eagerly — `deferredSections` is empty.

---

### Types

#### `AsyncRenderingConfig`

```ts
interface AsyncRenderingConfig {
  respectCmsLazy: boolean;     // Default true — use Lazy.tsx wrappers as deferral source
  foldThreshold: number;       // Default Infinity — fallback for non-wrapped sections
  alwaysEager: Set<string>;    // Section keys that must always be eager
}
```

#### `DeferredSection`

```ts
interface DeferredSection {
  component: string;
  key: string;
  index: number;
  rawProps: Record<string, unknown>;
}
```

---

### Edge Cases and Gotchas

#### 1. CMS Lazy.tsx is the source of truth
Editors wrap sections in `website/sections/Rendering/Lazy.tsx` in the CMS admin. The framework detects this via `isCmsDeferralWrapped()` and defers those sections. Sections NOT wrapped are eager (with `foldThreshold: Infinity`).

#### 2. Block references to Lazy
A section may reference a named block (e.g., `"Footer - 01"`) whose underlying definition is `Lazy.tsx`. `isCmsDeferralWrapped` resolves one level of block reference to detect this.

#### 3. alwaysEager overrides Lazy wrapping
If `Footer.tsx` is in `alwaysEager` but wrapped in Lazy in the CMS, it stays eager. This is intentional — layout sections must always be in the initial HTML.

#### 4. Multivariate flags are always eager
Individual sections wrapped in `website/flags/multivariate.ts` require runtime matcher evaluation and can't be safely deferred.

#### 5. InvalidCharacterError with section rendering
In TanStack Start, resolved sections have `Component` as a string key (not a React component). Use `SectionRenderer` or `SectionList` from `@decocms/start/hooks` to render sections — never destructure `{ Component, props }` and use as JSX directly.

#### 6. Navigation flash prevention
Don't use `pendingComponent` on CMS routes — it replaces the entire page content (including Header/Footer) during transitions. Instead, use a root-level `NavigationProgress` bar that keeps previous page visible while loading.

---

### Public API Summary

#### From `@decocms/start/cms`

| Export | Type | Description |
|--------|------|-------------|
| `setAsyncRenderingConfig` | Function | Enable/configure async rendering |
| `getAsyncRenderingConfig` | Function | Read current config |
| `registerCacheableSections` | Function | Register sections for SWR loader caching |
| `runSingleSectionLoader` | Function | Run a single section's loader |
| `resolveDeferredSection` | Function | Fully resolve a deferred section's raw props |
| `preloadSectionModule` | Function | Eagerly import a section to extract LoadingFallback |

#### From `@decocms/start/routes`

| Export | Type | Description |
|--------|------|-------------|
| `loadDeferredSection` | ServerFn | Server function to resolve + enrich deferred section on demand |

#### From `@decocms/start/hooks`

| Export | Type | Description |
|--------|------|-------------|
| `DecoPageRenderer` | Component | Renders page with eager + deferred section support |
| `SectionRenderer` | Component | Renders a single section by registry key |
| `SectionList` | Component | Renders an array of sections |

---

## Part 2: Site Implementation

How to configure and use Async Section Rendering in your Deco storefront.

### When to Use This Reference

- Setting up async section rendering on a new or existing Deco site
- Creating `LoadingFallback` components for sections
- Adding `Lazy.tsx` wrappers to CMS page JSONs
- Debugging the red dashed "Missing LoadingFallback" dev warning
- Optimizing page payload size
- Preventing flash-white during SPA navigation

---

### Quick Start (3 steps)

#### 1. `src/setup.ts` — Enable async rendering

```ts
import {
  setAsyncRenderingConfig,
  registerCacheableSections,
} from "@decocms/start/cms";

// Uses CMS Lazy.tsx wrappers as the source of truth for deferral.
// No foldThreshold needed — editors control what's lazy via CMS admin.
setAsyncRenderingConfig({
  alwaysEager: [
    "site/sections/Header/Header.tsx",
    "site/sections/Footer/Footer.tsx",
    "site/sections/Theme/Theme.tsx",
    "site/sections/Miscellaneous/CookieConsent.tsx",
    "site/sections/Social/WhatsApp.tsx",
    "site/sections/Social/UserInteractions.tsx",
  ],
});

// Optional: SWR cache for heavy section loaders
registerCacheableSections({
  "site/sections/Product/ProductShelf.tsx": { maxAge: 180_000 },
  "site/sections/Product/ProductTabbedShelf.tsx": { maxAge: 180_000 },
  "site/sections/Content/Faq.tsx": { maxAge: 1_800_000 },
});
```

#### 2. Wrap sections in Lazy in CMS JSONs

In `.deco/blocks/pages-*.json`, wrap below-the-fold sections:

**Before:**
```json
{ "__resolveType": "site/sections/Product/ProductShelf.tsx", "products": {...} }
```

**After:**
```json
{
  "__resolveType": "website/sections/Rendering/Lazy.tsx",
  "section": {
    "__resolveType": "site/sections/Product/ProductShelf.tsx",
    "products": {...}
  }
}
```

**Rules for which sections to wrap:**
- First 3 visible content sections → **keep eager** (above the fold)
- Header, Footer, Theme, CookieConsent → **always eager** (in `alwaysEager`)
- SEO sections → **skip** (they're metadata, not visual)
- Everything else below the fold → **wrap in Lazy**

#### 3. Add LoadingFallback to every lazy section

Export `LoadingFallback` from the section file. See detailed patterns below.

---

### CMS Lazy Wrapper Strategy

#### Page audit checklist

For each CMS page (`pages-*.json`):

1. Count sections. Skip pages with ≤ 3 sections.
2. Identify above-the-fold content (typically SEO + Header + first 2 content sections).
3. Wrap everything else in `website/sections/Rendering/Lazy.tsx`.
4. Keep `alwaysEager` sections (Header, Footer, etc.) unwrapped even if they appear at the end.

#### Real-world example: Homepage

| Index | Section | Status |
|-------|---------|--------|
| 0 | Seo | Skip (metadata) |
| 1 | UserInteractions | Eager (alwaysEager) |
| 2 | Header | Eager (alwaysEager) |
| 3 | Carousel | Eager (above fold) |
| 4 | Slide | **Lazy** |
| 5 | Categorias | **Lazy** |
| 6 | ProductTabbedShelf | **Lazy** |
| 7 | ProductShelf | **Lazy** |
| ... | ... | **Lazy** |
| 21 | Footer | Eager (alwaysEager, even if wrapped in Lazy) |

Result: 4 eager + 17 lazy → **52% payload reduction**.

---

### Creating LoadingFallback Components

#### Key rules

1. **Match dimensions**: Same container classes, padding, and aspect ratio as the real section
2. **CSS-only**: Use `skeleton animate-pulse` classes. No JS, no hooks, no data.
3. **No props**: `LoadingFallback()` takes zero arguments
4. **One per section file**: Export from `src/sections/Foo.tsx`, not from the component file
5. **Represent the content**: Skeletons should visually match the final layout

#### Product Card Skeleton (reusable pattern)

Most shelf/grid sections contain product cards. Define a shared skeleton:

```tsx
function CardSkeleton() {
  return (
    <div className="card card-compact w-full lg:p-2.5 bg-white rounded-md">
      <div className="skeleton animate-pulse aspect-square w-full rounded" />
      <div className="flex flex-col gap-2 p-2 pt-3">
        <div className="skeleton animate-pulse h-3 w-16 rounded" />
        <div className="skeleton animate-pulse h-4 w-full rounded" />
        <div className="skeleton animate-pulse h-4 w-3/4 rounded" />
        <div className="flex flex-col gap-1 mt-1">
          <div className="skeleton animate-pulse h-3 w-20 rounded" />
          <div className="skeleton animate-pulse h-5 w-28 rounded" />
          <div className="skeleton animate-pulse h-3 w-24 rounded" />
        </div>
        <div className="skeleton animate-pulse h-9 w-full rounded mt-2" />
      </div>
    </div>
  );
}
```

This matches the real `ProductCard` layout: image → flag → name (2 lines) → price block (from/to/installment) → buy button.

#### Pattern: Product Shelf

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full flex flex-col spacingComponents">
      <div className="customContainer mx-auto px-4">
        <div className="skeleton animate-pulse h-6 w-48 rounded mb-6" />
        <div className="flex gap-[1%] overflow-hidden">
          <div className="w-full lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="hidden md:block lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="hidden md:block lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="hidden lg:block lg:w-[24%] shrink-0"><CardSkeleton /></div>
        </div>
      </div>
    </div>
  );
}
```

#### Pattern: Tabbed Shelf

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full flex flex-col spacingComponents overflow-hidden">
      <div className="flex flex-col mx-4 lg:max-w-[84vw] w-full lg:mx-auto">
        <div className="skeleton animate-pulse h-4 w-32 rounded mb-4" />
        <div className="flex gap-4 lg:gap-7 mb-4">
          <div className="skeleton animate-pulse h-9 w-28 rounded-[10px]" />
          <div className="skeleton animate-pulse h-9 w-28 rounded-[10px]" />
          <div className="skeleton animate-pulse h-9 w-28 rounded-[10px] hidden md:block" />
        </div>
        <div className="flex gap-[1%] overflow-hidden mt-4">
          {/* Cards: 2 mobile, 3 tablet, 4 desktop */}
          <div className="w-[44%] lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="w-[44%] lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="hidden md:block lg:w-[24%] md:w-[32%] shrink-0"><CardSkeleton /></div>
          <div className="hidden lg:block lg:w-[24%] shrink-0"><CardSkeleton /></div>
        </div>
      </div>
    </div>
  );
}
```

#### Pattern: Search Result (PLP)

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full customContainer px-4 py-8 flex gap-6" style={{ minHeight: 600 }}>
      {/* Sidebar filters */}
      <div className="hidden lg:flex flex-col gap-6 w-64 shrink-0">
        <div className="skeleton animate-pulse h-7 w-32 rounded" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3 pb-4 border-b border-gray-200">
            <div className="skeleton animate-pulse h-5 w-24 rounded" />
            {Array.from({ length: 4 }).map((_, j) => (
              <div key={j} className="flex items-center gap-2">
                <div className="skeleton animate-pulse h-4 w-4 rounded" />
                <div className="skeleton animate-pulse h-3 w-20 rounded" />
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* Product grid */}
      <div className="flex-1">
        <div className="flex items-center justify-between mb-4">
          <div className="skeleton animate-pulse h-7 w-48 rounded" />
          <div className="skeleton animate-pulse h-8 w-32 rounded" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
```

#### Pattern: Full-width Banner/Carousel

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full">
      <div className="skeleton animate-pulse w-full h-[300px] lg:h-[420px]" />
    </div>
  );
}
```

#### Pattern: FAQ Accordion

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full customContainer px-4 py-8 flex flex-col gap-4 lg:py-10 lg:px-40"
         style={{ minHeight: 400 }}>
      <div className="skeleton animate-pulse h-6 w-48 mx-auto rounded" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="skeleton animate-pulse h-12 w-full rounded" />
      ))}
    </div>
  );
}
```

#### Pattern: Testimonials/Cards Grid

```tsx
export function LoadingFallback() {
  return (
    <div className="w-full customContainer px-4 py-8 flex flex-col gap-8">
      <div className="skeleton animate-pulse h-6 w-48 rounded mx-auto" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-3 p-6 bg-white rounded-lg">
            <div className="skeleton animate-pulse w-16 h-16 rounded-full" />
            <div className="skeleton animate-pulse h-4 w-32 rounded" />
            <div className="skeleton animate-pulse h-4 w-full rounded" />
            <div className="skeleton animate-pulse h-4 w-3/4 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
```

#### Pattern: Footer

```tsx
export function LoadingFallback() {
  return (
    <div className="bg-[#f3f3f3] w-full" style={{ minHeight: 600 }}>
      <div className="customContainer px-4 py-10">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-8 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-3">
              <div className="skeleton animate-pulse h-5 w-32 rounded" />
              {Array.from({ length: 5 }).map((_, j) => (
                <div key={j} className="skeleton animate-pulse h-3 w-24 rounded" />
              ))}
            </div>
          ))}
        </div>
        <div className="skeleton animate-pulse h-16 w-32 rounded mx-auto" />
      </div>
    </div>
  );
}
```

---

### SPA Navigation: NavigationProgress

**Do NOT use `pendingComponent`** on CMS routes — it replaces the entire page content (Header/Footer disappear, causing a "flash white").

Instead, add a root-level progress bar in `__root.tsx`:

```tsx
import { useRouterState } from "@tanstack/react-router";

const PROGRESS_CSS = `
@keyframes progressSlide { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.nav-progress-bar { animation: progressSlide 1s ease-in-out infinite; }
`;

function NavigationProgress() {
  const isLoading = useRouterState({ select: (s) => s.isLoading });
  if (!isLoading) return null;
  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] h-1 bg-primary/20 overflow-hidden">
      <style dangerouslySetInnerHTML={{ __html: PROGRESS_CSS }} />
      <div className="nav-progress-bar h-full w-1/3 bg-primary rounded-full" />
    </div>
  );
}
```

Add `<NavigationProgress />` before your main layout in `RootLayout`.

---

### Configuration Reference

#### `setAsyncRenderingConfig(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `respectCmsLazy` | `boolean` | `true` | Use CMS Lazy.tsx wrappers as deferral source |
| `foldThreshold` | `number` | `Infinity` | Fallback for non-wrapped sections (Infinity = only Lazy-wrapped defer) |
| `alwaysEager` | `string[]` | `[]` | Section keys that are ALWAYS eager regardless |

#### `registerCacheableSections(configs)`

```ts
registerCacheableSections({
  "site/sections/Product/ProductShelf.tsx": { maxAge: 180_000 },  // 3 min SWR
});
```

Good candidates: Product shelves (2-3 min), FAQ/content (15-30 min). NOT for PDP ProductInfo (must be per-product fresh).

---

### Debugging

#### Section not being deferred

1. Is `setAsyncRenderingConfig()` called in `setup.ts`?
2. Is the section wrapped in `website/sections/Rendering/Lazy.tsx` in the CMS JSON?
3. Is the section key in `alwaysEager`?
4. Is it a layout section (`registerLayoutSections`)?
5. Is it wrapped in a multivariate flag? (always eager)
6. Is the user-agent a bot? (bots always get full eager)

#### Verifying with curl

```bash
# Normal user — count deferred sections
curl -s http://localhost:5173/ | grep -c 'data-deferred'

# Bot — should have 0 deferred
curl -s -A "Googlebot/2.1" http://localhost:5173/ | grep -c 'data-deferred'

# Compare payload size
curl -s -o /dev/null -w "Normal: %{size_download}\n" http://localhost:5173/
curl -s -o /dev/null -w "Bot:    %{size_download}\n" -A "Googlebot/2.1" http://localhost:5173/
```

#### InvalidCharacterError with sections

If you see `Failed to execute 'createElement'` with a section path as tag name, the component is using `{ Component, props }` destructuring directly as JSX. Use `SectionRenderer` or `SectionList` from `@decocms/start/hooks` instead.

---

### Performance Impact

Measured on `espacosmart-storefront`:

| Page | Before | After | Reduction |
|------|--------|-------|-----------|
| Homepage (22 sections) | 8.7 MB | 4.2 MB | **52%** |
| PDP (8 sections) | 8.3 MB | 3.6 MB | **56%** |
| PLP (6 sections) | 646 KB | ~400 KB | **38%** |

---

### Checklist for New Sites

- [ ] Call `setAsyncRenderingConfig()` in `setup.ts` with `alwaysEager` sections
- [ ] Audit all CMS page JSONs — wrap below-fold sections in `Lazy.tsx`
- [ ] Add `LoadingFallback` export to every section used in Lazy wrappers
- [ ] Use detailed skeletons (product card structure, not just gray boxes)
- [ ] Add `NavigationProgress` to `__root.tsx` (NOT `pendingComponent` on routes)
- [ ] Pass `deferredSections` and `loadDeferredSectionFn` in `$.tsx` and `index.tsx`
- [ ] Optionally call `registerCacheableSections()` for heavy section loaders
- [ ] Verify with `curl` that bots get full eager pages
- [ ] Measure payload reduction with `curl -o /dev/null -w "%{size_download}"`
- [ ] Run dev mode and fix all red "Missing LoadingFallback" warnings

---

## #52 Fresh-era 3-arg section loaders (`props, req, ctx`) silently never receive `ctx` — no error, no log

**Severity**: BLOCKER — resolves to unenriched/default props on every request, across every migrated site, with zero signal.

`SectionLoaderFn` in `@decocms/blocks/cms/sectionLoaders.ts` is `(props, req) => ...` — 2 arguments, no `ctx`. Fresh-era loaders carried over as `(props, req, ctx) => ({ ...props, device: ctx.device })` (or reading `ctx.invoke`, `ctx.get`) always resolve `ctx` as `undefined`. `runSingleSectionLoaderImpl` wraps every loader call in a try/catch, so the resulting crash (or silent `ctx.device` → `undefined`) never surfaces anywhere — the section just renders with default/empty values.

**Symptom**: CMS content doesn't enrich props; device-conditional rendering always picks one branch; a component that reads a ctx-provided flag behaves as if the flag is always off. On farmrio this was the root cause of a **site-wide dead legal-compliance cookie-consent banner** (OneTrust/Optanon never rendered anywhere, `isProduction` always `undefined`) and of `BannerCollection.tsx` always serving the desktop image to mobile UAs.

**Fix** — rewrite the ctx-dependent line to a ctx-free equivalent, reusing the framework's own primitives instead of inventing new ones:

```typescript
// Before (dead — ctx is always undefined)
export const loader = (props, req, ctx) => ({ ...props, device: ctx.device });

// After
import { detectDevice } from "@decocms/blocks/sdk/useDevice";
export const loader = (props, req) => ({
  ...props,
  device: detectDevice(req.headers.get("user-agent")),
});
```

Other `ctx.*` replacements found across the farmrio sweep: `ctx.get/invoke({__resolveType})` → `resolveValue({__resolveType, ...}, undefined, {userAgent, url, path, request})` from `@decocms/blocks/cms`; `ctx.invoke.vtex.loaders/actions.X` → the direct function export from `@decocms/apps-vtex`.

**Discovery command**:
```bash
grep -rn "^export \(const\|function\|async function\) loader" src | grep -E "\(props.*req.*ctx"
```
Cross-reference each match's real CMS key (see #53 — file path and registration key can diverge) against `.deco/blocks.gen.json` and the `registerSectionLoaders(...)` call in `src/setup/section-loaders.ts` before assuming a fix landed.

**Empirical evidence (farmrio-storefront)**: repo-wide sweep of ~28 candidate files found 18 confirmed live bugs, including a site-wide dead cookie-consent banner and 4 independent `ctx.device`/`ctx.isMobile` occurrences on eager-rendered sections. See `migration/learnings/T42.md`, `T41.md`.

**Proposed codemod** (`packages/blocks-cli`): AST walk for arrow/function `loader` exports of arity 3, cross-reference the resolved section key against `registerSectionLoaders` calls, flag any 3-arg loader whose resolved key is unregistered or whose `ctx` param is read. Would have caught all 28 candidate files at migration time instead of via a manual sweep.

---

## #53 CMS section registration key can differ from the component's file path

**Severity**: MEDIUM — makes a "fix" for #52 silently re-create the exact same bug if the wrong key is used.

`registerSectionLoaders()`/`withSectionLoader()` key on the component's CMS `__resolveType`, not its file path. A component can live at `src/components/ui/alert/Alert.tsx` but resolve under `"site/sections/Content/Alert.tsx"` — guessing the key from the file path silently recreates the exact same "loader never runs" failure mode as #52, with the same zero-error signature.

**Fix**: before registering, check the component's actual resolveType:
```bash
grep -n "Alert.tsx" .deco/blocks.gen.json
```
Register under whatever string appears as `__resolveType`, not the file's on-disk path.

**Discovery command**: diff every loader-exporting file's path against its real `__resolveType` in `.deco/blocks.gen.json` before wiring a registration.

**Empirical evidence (farmrio-storefront)**: found during the same 28-file #52 sweep; also found a component (`OrderStatus.tsx`) that was never a CMS section at all (absent from `blocks.gen.json` entirely) — `registerSectionLoaders` can never make that one run, regardless of key. See `migration/learnings/T42.md`.

---

## #54 A resolved nested `Section`'s `.Component` is a **string**, never a function — `typeof Component === "function"` is always false

**Severity**: HIGH — silently drops entire conditional/nested render branches; recurred independently across at least 6 files in one migration.

Some Fresh→React ports of a nested-`Section[]`-rendering component guard with `.filter((s) => typeof s?.Component === "function")` before rendering `<Component {...props} />` directly — a defensive pattern usually added to avoid an earlier SSR crash from rendering an unresolved string as a JSX tag. In this resolver, a resolved section's `Component` field is the manifest **registry key string**, never an actual function reference — so the filter always evaluates false and the branch always renders empty, with no error.

**Fix**: don't gate on `typeof`, and don't render `Component` directly — filter falsy values and delegate to the framework's own section renderer:
```tsx
// Before — always false, entire branch silently dropped
sections.filter((s) => typeof s?.Component === "function")
  .map((s) => <s.Component {...s.props} />)

// After
sections.filter(Boolean)
  .map((s, i) => <RenderSection key={i} section={s} />)
```

**Discovery command**:
```bash
rg "typeof.*Component.*===.*[\"']function[\"']" src --type ts
```

**Empirical evidence (farmrio-storefront)**: found independently in `SearchContainer.tsx` (search empty-state, T44), `Layout/Flex.tsx` (PLP controls block missing site-wide, T58), and `Header.tsx`'s `CountdownComponent` guard (T62) — plus 3 further latent occurrences found by a repo-wide sweep (`List/Sections.tsx`, `Gallery.tsx`, `Layout/Container.tsx`, `Animation/Animation.tsx`), all fixed the same way and verified via `vite preview` + Playwright with zero console errors before/after. See `migration/learnings/T44.md`, `T58.md`, `T62.md`.

**Proposed codemod** (`packages/blocks-cli`): flag `typeof <expr>.Component === "function"` / `typeof <expr> === "function"` guards on a value that originates from CMS section resolution — this pattern is categorically dead in every version of this resolver.

---

## #73 Section loaders have no sink for response mutation — no cookies, no headers, no redirects

**Severity**: HIGH — Fresh-era loader logic that forced a redirect or set a response cookie/header has no restoration path today, not even after fixing #52's `ctx` arity.

`RequestContext.responseHeaders` (`@decocms/blocks/sdk/requestContext.ts`) exists and is populated during section-loader execution (`RequestContext.run()` wraps it in `@decocms/tanstack`'s `workerEntry.ts`), but nothing in the full-page SSR render path reads it back into the outgoing `Response` — only the generated `src/server/invoke.gen.ts` client-invoke/action path consumes it. Separately, `~/types/deco`'s `redirect()` is a hard-coded stub that throws `"redirect is not supported in TanStack Start — use router navigation instead."`

**Symptom**: a section loader that used to call `setResponseCookie(...)`/`ctx.response.headers.append(...)` for a real purpose (sticky popup dismissal, analytics cookie, `Link: rel=preload`) or force a campaign-takeover redirect has no way to do either on initial page load — silently a no-op, not an error.

**Discovery command**:
```bash
grep -rn "responseHeaders" node_modules/@decocms/blocks node_modules/@decocms/tanstack
grep -rn "not supported in TanStack Start" node_modules -r
```

**Fix**: none available in site code today. Proposed upstream (either would close the gap): (a) have the TanStack Start page-render route copy `RequestContext.responseHeaders` into its `Response` before returning, mirroring what `invoke.gen.ts` already does for the action path; or (b) a documented `withResponseHeaders`/`withRedirect` mixin so authors discover the missing capability explicitly instead of via a silent no-op.

**Empirical evidence (farmrio-storefront)**: 3 affected files found in one sweep (`FarmetePopup.tsx`, `Analytics/AllPages.tsx`, `Theme/Fonts.tsx`) plus 2 dead `redirect()` branches in a campaign-takeover component (`Tapume.tsx`) — none restorable within a section loader on the current framework version. See `migration/learnings/T42.md`.
