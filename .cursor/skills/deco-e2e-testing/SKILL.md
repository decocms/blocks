---
name: deco-e2e-testing
description: Implement end-to-end performance tests for any Deco e-commerce site with lazy section tracking, cache analysis, and observability. Use this skill when asked to set up e2e tests, create performance testing infrastructure, or test user journeys on a Deco/VTEX site.
---

# Deco E2E Performance Testing Skill

This skill helps you implement comprehensive e2e performance tests for Deco e-commerce sites. It covers the full user journey: Home → PLP → PDP → Add to Cart, with **lazy section tracking**, **cache analysis**, and **device-specific reports**.

## When to Use This Skill

- Setting up e2e tests from scratch on a Deco site
- Creating performance testing infrastructure
- Testing cache performance (cold vs warm)
- Validating TTFB, FCP, and other Core Web Vitals
- **Debugging slow lazy sections** (`/deco/render` requests)
- **Analyzing page cache and CDN behavior**
- **Comparing performance across desktop/mobile**

## Quick Start

1. **Discover site-specific values** (read `discovery.md`)
2. **Run scaffold script** or copy templates manually
3. **Configure selectors** for your site
4. **Add package.json scripts** for easy test execution
5. **Run tests** and verify

## Workflow

```
1. Read discovery.md → Find site-specific selectors
2. Run scaffold.sh → Create test directory structure
3. Replace {{PLACEHOLDERS}} → Customize for site
4. Add package.json scripts → Enable `npm run test:e2e`
5. npm install && npm run test:e2e → Verify tests work
```

## Directory Structure to Create

```
tests/e2e/
├── README.md
├── package.json
├── playwright.config.ts
├── tsconfig.json
├── specs/
│   └── ecommerce-flow.spec.ts
├── utils/
│   └── metrics-collector.ts
├── scripts/
│   └── baseline.ts
└── reports/                    # gitignored
    ├── report-desktop-chrome.json
    ├── report-mobile-chrome.json
    └── baselines/

scripts/
└── run-e2e.ts                  # Test runner with server management
```

## Test Flow

| Step | Page | Metrics |
|------|------|---------|
| 1 | Server Warmup | Liveness check, lazy import trigger |
| 2 | Homepage (cold cache) | TTFB, FCP, lazy sections, scroll |
| 3 | Homepage (warm cache) | Cache improvement |
| 4 | PLP (cold cache) | TTFB, products loaded, lazy sections |
| 5 | PLP (warm cache) | Cache improvement |
| 6 | PDP (cold cache) | TTFB, buy button, lazy sections |
| 7 | PDP (warm cache) | Cache improvement |
| 8 | Add to Cart | Response time |
| 9 | Minicart | Verification (with retry) |

## Key Features

### 1. Lazy Section Tracking (rewritten — see note)

> **The header-based version of this feature described in older versions of
> this skill is dead.** It assumed a Fresh/Deno-era Deco runtime that
> round-tripped every lazy section through `/deco/render` and stamped the
> response with `x-deco-section` / `x-deco-page` / `x-deco-route` headers. A
> grep of the current `packages/runtime`, `packages/admin`, `packages/tanstack`,
> and `packages/next` source (2026-07) for
> `x-deco-section|x-deco-page|x-deco-route|x-deco-platform` returns **zero
> hits**. `/deco/render` still exists (`packages/admin/src/admin/render.ts`,
> wired via `decoRenderRoute` in `packages/tanstack/src/routes/adminRoutes.ts`
> and the Next.js route handlers in `packages/next`) but it is now the
> **admin visual-editor preview endpoint only** — it renders a section/page to
> an HTML string for the CMS iframe and sets no identifying headers at all
> (just `Content-Type`). It is never hit during normal storefront browsing.

**What actually happens today:** lazy/deferred sections are a client-side
rendering concern, not a per-section HTTP fetch with identifying headers.

- `packages/runtime/src/hooks/LazySection.tsx` — a generic
  IntersectionObserver wrapper. When the wrapped element scrolls into view it
  flips React state and renders `children` instead of `fallback`. **No
  network request happens at all** — the component code is already in the
  bundle; this only delays mounting it.
- `packages/tanstack/src/hooks/DecoPageRenderer.tsx` (TanStack Start) and
  `packages/next/src/DeferredSection.tsx` / `SectionRenderer.tsx` (Next.js App
  Router) render each section inside a wrapper that carries
  **`data-manifest-key={section.key}`** (the section's identifier, e.g.
  `site/sections/Hero.tsx`) and, while the section is still a skeleton,
  **`data-deferred="true"`**. Once the section resolves, the wrapper is
  re-rendered without `data-deferred` and the real content replaces the
  skeleton.
- On TanStack, the initial page load streams deferred sections inline via SSR
  (Suspense + `Await`) — no client-visible request at all in the common case.
  There is a `loadDeferredSection` TanStack `createServerFn` (POST, in
  `packages/tanstack/src/routes/cmsRoute.ts`) used as a fallback for SPA
  navigation, explicitly marked `@deprecated` in favor of native streaming;
  its POST body carries `{ component, pagePath, pageUrl, index }`, but the
  request goes to TanStack's internal server-fn RPC path, not `/deco/render`,
  and there's no response header naming the section either.
- On Next.js, `DeferredSectionBoundary` (`packages/next/src/DeferredSection.tsx`)
  is RSC-native: it `await`s a promise inside an async Server Component under
  `<Suspense>`. The resolved section is streamed as part of the same HTTP
  response — there is no separate observable request per section at all.

**Modern replacement — track sections via the DOM, not HTTP headers:**

```typescript
// Section identifiers currently loading (skeleton) or already resolved.
const pendingKeys = await page.locator('[data-deferred="true"]')
    .evaluateAll(els => els.map(el => el.getAttribute('data-manifest-key')))

const allSectionKeys = await page.locator('[data-manifest-key]')
    .evaluateAll(els => els.map(el => el.getAttribute('data-manifest-key')))

// Timing: poll until a given section's data-deferred attribute disappears.
async function waitForSectionLoaded(page, manifestKey: string, timeout = 8000) {
    const start = Date.now()
    await page.waitForFunction(
        (key) => {
            const el = document.querySelector(`[data-manifest-key="${key}"]`)
            return el && !el.hasAttribute('data-deferred')
        },
        manifestKey,
        { timeout },
    )
    return Date.now() - start
}
```

This measures "when did the skeleton get replaced with real content"
(a DOM-mutation timing), which is a different signal than the old "how long
did the section's HTTP round trip take" — but it is the only lazy-section
signal the current frameworks actually expose. There is currently **no**
reliable cross-binding network signal (no header, no consistent URL pattern)
to reconstruct the old cache-HIT/MISS-per-section or color-coded timing
table below. If you need that fidelity, it is not implementable today without
framework changes — don't fabricate a fake header check that will silently
report all-MISS or find nothing.

Old (no longer produced by any current binding — kept only as a record of
what the removed feature used to look like):

```
🔄 Lazy Sections (14):
┌───────────────────────────────────────────────────────────
│ 🔴 Product/ProductShelf: L...  1182ms 💾 cached
│ 🔴 Product/ProductShelfGroup   1000ms 💾 cached
│ 🟢 Footer/Footer                 13ms 💾 cached
└───────────────────────────────────────────────────────────
📊 Summary: 5 fast, 2 medium, 7 slow │ Total: 7121ms
```

### 2. Scroll-Based Lazy Loading

The test scrolls the page to trigger lazy sections and waits for them:

```typescript
// Scroll until footer is visible, waiting for pending renders
await collector.scrollPage(page, true) // full=true for homepage
```

This ensures all lazy sections are triggered and their performance is measured.

### 3. Device-Specific Reports

Tests run on both desktop and mobile with separate reports:

```
reports/
├── report-desktop-chrome.json
├── report-mobile-chrome.json
├── report-latest-desktop.json
└── report-latest-mobile.json
```

### 4. Enhanced Report Structure

Reports include a summary for easy comparison:

```json
{
  "project": "desktop-chrome",
  "timestamp": "2026-01-18T...",
  "summary": {
    "totalPages": 7,
    "avgTTFB": 485,
    "avgFCP": 892,
    "totalLazyRenders": 32,
    "totalLoaders": 12,
    "cacheHits": 28,
    "cacheMisses": 4,
    "pages": [...]
  },
  "metrics": [...]
}
```

### 5. Deco Observability Signals

**Not header-based today.** Older versions of this skill captured custom
Deco response headers (`x-deco-section`, `x-deco-page`, `x-deco-route`) for
debugging. Those headers do not exist anywhere in the current runtime — see
the "Lazy Section Tracking" note above. The nearest current equivalent is the
`data-manifest-key` DOM attribute described there (identifies the section)
plus normal Playwright network inspection for the underlying data-loading
requests your app makes (e.g. `X-Deco-Cacheable` is set on some TanStack
server-fn responses to control edge caching, but it's not a per-section
identifier).

## Critical: Server Warmup

**Deco/Fresh lazily loads imports on first request.** This causes artificially high latency for the first request after server start. The test must:

1. Wait for `/deco/_liveness` endpoint to return 200
2. Make a warmup request to trigger lazy imports
3. Only then start measuring performance

```typescript
const LIVENESS_PATH = '/deco/_liveness'

async function waitForServerReady(baseUrl: string) {
    // Step 1: Wait for liveness
    for (let i = 0; i < 30; i++) {
        const res = await fetch(`${baseUrl}/deco/_liveness`)
        if (res.ok) break
        await new Promise(r => setTimeout(r, 1000))
    }

    // Step 2: Warmup request to trigger lazy imports
    await fetch(`${baseUrl}/?__d`)
}
```

## Key Configuration

The `SITE_CONFIG` object centralizes all site-specific values:

```typescript
const SITE_CONFIG = {
    // URLs
    baseUrl: 'https://localhost--{sitename}.deco.site',
    plpPath: '/category-path',
    fallbackPdpPath: '/product-name-sku/p',
    
    // Always use ?__d for Server-Timing headers
    debugParam: '?__d',

    // Deco framework endpoints
    livenessPath: '/deco/_liveness',

    // Selectors
    productCard: '[data-deco="view-product"]',
    productCardFallback: 'a:has-text("R$")',
    buyButton: 'button:has-text("Comprar agora")',
    buyButtonFallback: 'button:has-text("Comprar")',
    minicartText: 'Produtos Adicionados',

    // Sizes (fashion) or voltages (electronics)
    sizes: ['P', 'M', 'G', 'GG'],
    voltages: ['110V', '127V', '220V', 'Bivolt'],

    // Thresholds (ms)
    thresholds: {
        coldTTFB: 5000,
        warmTTFB: 2000,
        homeTTFB: 3000,
        homeWarmTTFB: 1500,
    },

    // Server warmup settings
    warmup: {
        livenessRetries: 30,
        livenessRetryDelay: 1000,
        warmupTimeout: 60000,
    },
}
```

## package.json Integration

Current sites are TanStack Start (Vite, `bun run dev` / `npm run dev` →
`vite dev`) or Next.js App Router (`npm run dev` / `bun run dev` → `next
dev`) — both driven by `package.json` scripts, not `deno.json`/`deno task`.
Add these scripts to the **site's own** `package.json` (not the test
directory's):

```jsonc
{
  "scripts": {
    "test:e2e": "tsx scripts/run-e2e.ts",
    "test:e2e:headed": "tsx scripts/run-e2e.ts --headed",
    "test:e2e:install": "cd tests/e2e && npm install && npx playwright install chromium",
    "test:e2e:baseline:save": "tsx tests/e2e/scripts/baseline.ts save",
    "test:e2e:baseline:compare": "tsx tests/e2e/scripts/baseline.ts compare"
  }
}
```

Use whichever TS runner the site already has available (`tsx`, `bun run`, or
plain `ts-node`) — `tsx` above is a reasonable default since it works with
both npm- and bun-managed sites. If the site uses Bun as its package manager,
`bun run test:e2e` invokes the same script.

## .gitignore Updates

Add to `.gitignore`:

```gitignore
# E2E test reports (generated artifacts)
tests/e2e/reports/report-*.json
tests/e2e/reports/test-results/
tests/e2e/reports/results.json
```

## Files in This Skill

| File | Purpose |
|------|---------|
| `SKILL.md` | This overview |
| `discovery.md` | How to find site-specific values |
| `templates/` | Ready-to-use test files |
| `templates/scripts/run-e2e.ts` | Test runner with server management |
| `templates/scripts/baseline.ts` | Baseline save/compare script |
| `selectors.md` | Platform-specific selector patterns |
| `troubleshooting.md` | Common issues and fixes |
| `scripts/scaffold.sh` | Auto-create test structure |

## Expected Output

```
══════════════════════════════════════════════════════════════════════
🖥️  Desktop (desktop-chrome)
══════════════════════════════════════════════════════════════════════

══════════════════════════════════════════════════════════════════════
🏠 HOMEPAGE (cold cache)
══════════════════════════════════════════════════════════════════════
   📜 Scrolling to trigger lazy renders (full)...
      ⏳ Waiting for 1 pending render before next scroll...
      ✅ Footer visible after 47 scrolls
   📜 Triggered 13 lazy renders

   🟢 TTFB:   414ms  🟡 FCP:  1508ms  │  🌐 369 requests (11.7 MB)

   ⚡ Server Timing: 0ms total (1 loaders)

   🔄 Lazy Sections (14):
   ┌───────────────────────────────────────────────────────────
   │ 🔴 Product/ProductShelf: L...  1182ms 💾 cached
   │ 🔴 Product/ProductShelfGroup   1000ms 💾 cached
   │ 🟢 Content/SimpleText            18ms 💾 cached
   │ 🟢 Footer/Footer                 13ms 💾 cached
   └───────────────────────────────────────────────────────────
   📊 Summary: 5 fast, 2 medium, 7 slow │ Total: 7121ms

══════════════════════════════════════════════════════════════════════
📊 PERFORMANCE SUMMARY
══════════════════════════════════════════════════════════════════════

   ┌──────────────────┬─────────────┬─────────────┬────────┐
   │ Page             │       TTFB  │        FCP  │  Lazy  │
   ├──────────────────┼─────────────┼─────────────┼────────┤
   │ Homepage Cold    │ 🟢   414ms │  🟡  1508ms │     14 │
   │ Homepage Warm    │ 🟢   485ms │  🟢   560ms │      4 │
   │ PLP Cold         │ 🟢   456ms │  🟢   508ms │      3 │
   │ PDP Cold         │ 🟢   459ms │  🟢   520ms │      4 │
   └──────────────────┴─────────────┴─────────────┴────────┘

   Legend: 🟢 Good  🟡 Needs Work  🔴 Poor
   Thresholds: TTFB <500ms good, <800ms ok | FCP <1000ms good, <1800ms ok
```

## Baseline Comparison

Save performance baselines and compare future runs to detect regressions.

### Save a Baseline

```bash
npm run test:e2e:baseline:save
```

### Compare Against Baseline

```bash
npm run test:e2e:baseline:compare
```

### Regression Thresholds

| Metric | Threshold |
|--------|-----------|
| TTFB   | +10% |
| FCP    | +10% |
| LCP    | +15% |
| CLS    | +50% |

## Minicart Robustness

The minicart verification uses multiple selectors and retry logic:

```typescript
async isMinicartOpen(): Promise<boolean> {
    const selectors = [
        `text=${SITE_CONFIG.minicartText}`,
        '[data-testid="minicart"]',
        '.minicart',
        '[class*="minicart"]',
        '[class*="cart-drawer"]',
    ]
    
    // Retry with increasing timeout
    for (let attempt = 0; attempt < 3; attempt++) {
        const timeout = 2000 + (attempt * 1000)
        for (const selector of selectors) {
            const visible = await this.page.locator(selector).first()
                .isVisible({ timeout }).catch(() => false)
            if (visible) return true
        }
        await this.page.waitForTimeout(500)
    }
    return false
}
```

## Integration with Deco Runtime

**This section describes the current (2026-07) TanStack Start / Next.js
framework packages, not the old Fresh/Deno `deco/runtime`.** There is no
`deco/runtime/`, `apps/website/handlers/fresh.ts`, or header-setting
middleware in the current stack — that architecture (and the header-based
lazy-section observability it enabled) was retired with the Fresh → TanStack
migration.

For lazy/deferred section observability on a current site, the relevant
source is:

- `packages/runtime/src/hooks/LazySection.tsx` — generic IntersectionObserver
  deferral primitive (no network involved).
- `packages/tanstack/src/hooks/DecoPageRenderer.tsx` — TanStack Start's page
  renderer; wraps each section in `<section data-manifest-key={key}
  data-deferred={...}>` and streams deferred sections via SSR Suspense/Await.
- `packages/tanstack/src/routes/cmsRoute.ts` — the deprecated
  `loadDeferredSection` POST server-fn fallback used for SPA navigation.
- `packages/next/src/DeferredSection.tsx` and `packages/next/src/SectionRenderer.tsx`
  — Next.js App Router's RSC-native equivalents, same `data-manifest-key`
  convention.
- `packages/admin/src/admin/render.ts` — the current `/deco/render` handler.
  Still real, but it's the CMS visual-editor preview endpoint (renders a
  section/page to HTML for an iframe), not something a storefront visitor's
  browser calls while scrolling. It sets no `x-deco-*` headers.
- `packages/runtime/src/middleware/liveness.ts` and
  `packages/tanstack/src/sdk/workerEntry.ts` — confirm `/deco/_liveness`
  (and `/_liveness`) are still real, current endpoints. The warmup/liveness
  parts of this skill are unaffected by any of the above and don't need
  rewriting.

If you need per-section HTTP-level observability beyond what
`data-manifest-key`/`data-deferred` DOM tracking gives you, that would
require a runtime change (e.g. emitting a header or `Server-Timing` entry
from `DecoPageRenderer`/`DeferredSection`) — it doesn't exist today. Flag
this as a gap rather than inventing headers that aren't sent.

## Next Steps

1. Read `discovery.md` to learn how to find the correct selectors and paths
2. Check `selectors.md` for platform-specific patterns (VTEX, Shopify, VNDA)
3. See `troubleshooting.md` if tests fail
4. Use the MCP tools to search for related optimization patterns
