# Troubleshooting E2E Tests

Common issues and their solutions.

---

## Installation Issues

### `Cannot find package '@playwright/test'`

**Cause:** Dependencies not installed.

**Fix:**
```bash
cd tests/e2e
npm install
npx playwright install chromium
```

### Playwright browsers not found

**Cause:** Browser binaries not downloaded.

**Fix:**
```bash
npx playwright install chromium
# Or install all browsers:
npx playwright install
```

---

## Server Warmup Issues

### Extremely slow first request (10s+ TTFB)

**Cause:** Dev servers (Vite for TanStack Start, Next.js's dev server) lazily
compile/transform modules on the first request after start — the first
request triggers on-demand compilation of the route graph, causing
artificially high latency that doesn't reflect real-world performance. (This
is the modern equivalent of the old Fresh/Deno "lazy import" cold start —
same symptom, different mechanism, since neither TanStack nor Next.js sites
run on Deno/Fresh anymore.)

**Symptoms:**
- First test shows TTFB of 10-30+ seconds
- Subsequent tests are much faster
- Only happens right after starting the dev server (`npm run dev` /
  `bun run dev`)
- "No products loaded" if test times out during warmup

**Fix:** Add server warmup in `test.beforeAll`:

```typescript
async function waitForServerReady(baseUrl: string) {
    // Step 1: Wait for liveness endpoint (server is up)
    for (let i = 0; i < 30; i++) {
        try {
            const res = await fetch(`${baseUrl}/deco/_liveness`, {
                signal: AbortSignal.timeout(5000),
            })
            if (res.ok) break
        } catch {}
        await new Promise(r => setTimeout(r, 1000))
    }

    // Step 2: Warmup request to trigger lazy imports
    console.log('🔥 Warming up server (triggering lazy imports)...')
    await fetch(`${baseUrl}/?__d`, {
        signal: AbortSignal.timeout(60000),
    })
    console.log('✅ Warmup complete')
}

test.beforeAll(async () => {
    await waitForServerReady(SITE_CONFIG.baseUrl)
})
```

### Server not responding at `/deco/_liveness`

**Cause:** Liveness endpoint not available or server crashed during startup.

**Diagnosis:**
```bash
# Check if server is running (default dev ports: TanStack Start/Vite = 5173, Next.js = 3000)
curl -v http://localhost:5173/deco/_liveness   # TanStack Start
curl -v http://localhost:3000/deco/_liveness   # Next.js

# Check server logs for errors
npm run dev   # or: bun run dev
```

**Fix:** Increase liveness retry count and timeout:
```typescript
const warmup = {
    livenessRetries: 60,      // Increase from 30
    livenessRetryDelay: 1000,
    warmupTimeout: 120000,    // Increase from 60s
}
```

### Warmup request times out

**Cause:** Server is alive but first page load is extremely slow (heavy imports, slow VTEX API, etc).

**Fix:**
1. Increase warmup timeout
2. Consider warming up with a lighter page first
3. Check for slow loaders in the homepage

```typescript
// Warmup with liveness first (very light)
await fetch(`${baseUrl}/deco/_liveness`)

// Then warmup with homepage
await fetch(`${baseUrl}/?__d`, {
    signal: AbortSignal.timeout(120000),  // 2 minutes
})
```

---

## Test Execution Issues

### Tests timeout

**Possible causes:**
1. Site not running
2. Tunnel not open
3. Network issues

**Diagnosis:**
```bash
# Check if site is accessible
curl -I http://localhost:5173   # TanStack Start (Vite)
curl -I http://localhost:3000   # Next.js

# Check if dev server is running
npm run dev   # or: bun run dev
```

**Fix:** Start the dev server (`npm run dev` / `bun run dev`, per the site's
`package.json`) and, if the site is only reachable through a tunnel (e.g. for
mobile device testing or a hosted preview), ensure the tunnel is active.

### Products not loading on PLP

**Possible causes:**
1. Products require JavaScript hydration
2. Wrong selector
3. Site has loading states/skeletons

**Diagnosis:**
```typescript
// Add debug logging
const productCount = await page.locator('a:has-text("R$")').count()
console.log(`Found ${productCount} products`)

// Take a screenshot
await page.screenshot({ path: 'debug-plp.png' })
```

**Fixes:**
```typescript
// Wait longer for hydration
await page.waitForTimeout(3000)

// Wait for specific element that indicates load complete
await page.waitForSelector('[data-loaded="true"]')

// Use fallback PDP if PLP fails
if (productCount === 0) {
    await page.goto(SITE_CONFIG.fallbackPdpPath)
}
```

---

## Product Selection Issues

### Voltage/variant modal blocks minicart

**Cause:** Electronics products require voltage selection (110V/220V). If the product shows a voltage modal before add to cart, and the test doesn't handle it, the cart operation may fail silently.

**Symptoms:**
- Add to cart seems to succeed (buy button clicked)
- Minicart never opens
- No error thrown

**Fixes:**

1. **Best fix: Choose products without voltage requirements for tests**
   - Use non-electronics categories (e.g., `/utilidades-domesticas` instead of `/eletroportateis`)
   - Use simple products like thermal boxes, pillows, kitchenware as fallback PDP
   - Avoid smartphones, air fryers, TVs, and other electronics

2. **If you must test electronics, handle voltage selection:**
   ```typescript
   // Select voltage BEFORE clicking add to cart
   async selectVoltage(): Promise<string | null> {
       for (const voltage of ['110V', '127V', '220V', 'Bivolt']) {
           const btn = this.page.locator(`button:has-text("${voltage}")`).first()
           if (await btn.count() > 0 && await btn.isEnabled()) {
               await btn.click()
               await this.page.waitForTimeout(300)
               return voltage
           }
       }
       return null
   }
   ```

3. **Always assert minicart visibility:**
   ```typescript
   const minicartOpen = await actions.isMinicartOpen()
   expect(minicartOpen, 'Minicart should be visible after add to cart').toBe(true)
   ```

### Fallback PDP product out of stock

**Cause:** Hardcoded fallback PDP may go out of stock over time.

**Fix:** Choose stable, always-available products like:
- Store brand items (always in stock)
- Basic accessories (thermal boxes, pillows, etc.)
- Avoid seasonal or limited items

---

## Selector Issues

### Buy button not found

**Possible causes:**
1. Wrong button text
2. Button inside shadow DOM
3. Button dynamically rendered

**Diagnosis:**
```typescript
// Log all buttons on page
const buttons = await page.locator('button').all()
for (const btn of buttons) {
    console.log(await btn.textContent())
}
```

**Common button texts to try:**
- `Comprar`
- `Adicionar`
- `Add to Cart`
- `Buy Now`
- `Adicionar ao Carrinho`

### Size buttons not clickable

**Possible causes:**
1. Sizes are in `<input>` not `<button>`
2. Need to click parent element
3. Out of stock sizes disabled

**Diagnosis:**
```typescript
// Check if using radio inputs instead
const radios = await page.locator('input[type="radio"]').count()
console.log(`Found ${radios} radio inputs`)
```

**Fixes:**
```typescript
// Try input elements
sizeButton: (size: string) => `input[value="${size}"]`

// Try label elements
sizeButton: (size: string) => `label:has-text("${size}")`
```

### Minicart not opening

**Possible causes:**
1. Cart uses URL navigation (`/cart`) instead of drawer
2. Overlay/modal not detected
3. Different minicart text

**Diagnosis:**
```typescript
// Check URL after add to cart
console.log('Current URL:', page.url())

// Check for any cart-related text
const cartText = await page.locator('text=/cart|sacola|bag/i').first()
console.log('Cart element:', await cartText.isVisible())
```

**Fixes:**
```typescript
// If cart redirects to /cart page
if (page.url().includes('/cart')) {
    console.log('Cart uses page navigation, not drawer')
    // Test passes - cart works
}

// Try multiple minicart texts
const minicartTexts = ['Minha Sacola', 'Sacola', 'Carrinho', 'Cart']
for (const text of minicartTexts) {
    if (await page.locator(`text=${text}`).isVisible().catch(() => false)) {
        console.log(`Minicart found with text: ${text}`)
        break
    }
}
```

---

## Performance Issues

### TTFB too high (> 5s)

**Possible causes:**
1. Cold cache on first request
2. Slow VTEX API
3. Too many sync loaders

**This is often normal for first requests.** Check warm cache performance instead.

**Fixes:**
- Increase threshold for cold cache
- Focus assertions on warm cache performance
- Check `?__d` response for slow loaders

### Warm cache not faster than cold

**Possible causes:**
1. Cache not working
2. Different pages being tested
3. Dynamic content

**Diagnosis:**
```typescript
console.log(`Cold: ${coldMetrics.performance.TTFB}ms`)
console.log(`Warm: ${warmMetrics.performance.TTFB}ms`)

const improvement = coldMetrics.performance.TTFB - warmMetrics.performance.TTFB
console.log(`Improvement: ${improvement}ms`)
```

**If no improvement:** Check server-timing headers for cache status.

---

## Network Issues

### Cart response not detected

**Possible causes:**
1. Different API endpoint
2. Response timeout
3. Cart uses WebSocket

**Diagnosis:**
```typescript
// Log all responses after click
page.on('response', (res) => {
    if (res.url().includes('cart') || res.url().includes('order')) {
        console.log('Cart response:', res.url(), res.status())
    }
})
```

**Fixes:**
```typescript
// Add more endpoint patterns
await page.waitForResponse(r => 
    r.url().includes('orderForm') ||
    r.url().includes('cart') ||
    r.url().includes('items') ||
    r.url().includes('checkout'),
    { timeout: 10000 }
)

// Or just wait fixed time
await page.waitForTimeout(3000)
```

---

## Process Cleanup Issues

### Server lingers after test interruption

**Cause:** When tests are stopped with Ctrl+C or fail midway, the dev server process may not be properly terminated.

**Symptoms:**
- Next test run fails because the dev port is already in use (default:
  `5173` for TanStack Start/Vite, `3000` for Next.js)
- Multiple `vite`/`next dev` processes running in background
- "Address already in use" errors

**Check for lingering processes:**
```bash
# Find processes on the dev port
lsof -i :5173   # TanStack Start (Vite)
lsof -i :3000   # Next.js

# Find lingering dev-server processes
ps aux | grep -E "vite|next dev"
```

**Kill lingering processes:**
```bash
# Kill by port
kill $(lsof -t -i :5173)   # or :3000 for Next.js

# Or kill all matching dev processes (careful!)
pkill -f "vite dev"
pkill -f "next dev"
```

**Prevention:** The run-e2e.ts script handles cleanup automatically via:
- SIGINT handler (Ctrl+C)
- SIGTERM handler
- Unhandled rejection handler

If cleanup still fails, check that the script is using the latest version with signal handlers.

---

## Lazy Section Issues

> **Note:** current TanStack Start / Next.js sites don't fetch sections via
> `/deco/render` while browsing (that endpoint is now admin-preview-only —
> see SKILL.md's "Lazy Section Tracking" section). Lazy/deferred sections are
> tracked via the `data-manifest-key` / `data-deferred` DOM attributes
> instead. The issues below are reframed around that mechanism.

### Lazy sections "hanging" or not loading

**Cause:** A deferred section's `IntersectionObserver` fires but its
resolution (SSR-streamed `Await`, or the deprecated
`loadDeferredSection` server-fn fallback used during SPA navigation) never
completes — e.g. a slow upstream loader, or the section's promise rejecting
without a caught error boundary.

**Symptoms:**
- Test times out waiting for footer / a specific section
- Some sections keep `data-deferred="true"` indefinitely
- Console shows a `[CMS] Deferred section cache miss` warning (from
  `packages/tanstack/src/routes/cmsRoute.ts`) if the SPA-nav fallback can't
  find cached raw props

**Fix:** Poll for `data-deferred` disappearing per section rather than
waiting on a network response, and cap the wait:

```typescript
// Never assume all sections resolve — cap the wait per section.
await page.waitForFunction(
    (key) => {
        const el = document.querySelector(`[data-manifest-key="${key}"]`)
        return el && !el.hasAttribute('data-deferred')
    },
    manifestKey,
    { timeout: 8000 },
).catch(() => console.log(`Section ${manifestKey} still deferred after 8s`))
```

### Lazy section names showing as "Unknown Section"

**Cause:** The element you're inspecting doesn't have a `data-manifest-key`
attribute, or you're looking at a nested element instead of the `<section>`
wrapper that carries it.

**Fixes:**
1. Query the wrapper element directly: `[data-manifest-key]`, not a child.
2. `data-manifest-key` is the section's registry key (e.g.
   `site/sections/Hero.tsx`) — see `DecoPageRenderer.tsx` (TanStack) or
   `SectionRenderer.tsx`/`DeferredSection.tsx` (Next.js) for exactly how it's
   derived from `section.key` / `deferred.key`.
3. There is no header-based fallback anymore (`x-deco-section` doesn't
   exist) — if `data-manifest-key` is missing, the section markup itself is
   the problem, not a missing header.

### Too many lazy sections slowing down tests

**Cause:** Homepage with 20+ lazy sections takes a long time to scroll and load.

**Fix:** Use the `maxTime` option to limit scroll time:

```typescript
await collector.scrollPage({ full: true, maxTime: 20000 }) // 20s max
```

The test will still collect metrics for all triggered sections, but won't wait forever.

---

## Minicart Verification Issues

### Minicart not detected despite product being added

**Cause:** Different sites use different minicart implementations (drawer, modal, redirect to /cart).

**Symptoms:**
- Test says "Minicart not visible"
- Product was actually added (can see in network)
- Cart functionality works manually

**Fix:** Use robust selector with retry logic:

```typescript
async isMinicartOpen(): Promise<boolean> {
    const selectors = [
        `text=${SITE_CONFIG.minicartText}`,
        '[data-testid="minicart"]',
        '.minicart',
        '[class*="minicart"]',
        '[class*="cart-drawer"]',
        '[class*="drawer"][class*="open"]',
    ]
    
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

---

## Report Issues

### Desktop and mobile reports overwriting each other

**Cause:** Both device types saving to the same file.

**Fix:** Use `testInfo.project.name` to create unique files:

```typescript
test.beforeAll(async ({}, testInfo) => {
    projectName = testInfo.project.name || 'default'
})

test.afterAll(async () => {
    const reportFile = `./reports/report-${projectName}.json`
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
})
```

### Server Timing not showing loaders

**Cause:** The `?__d` debug flag is not being used.

**Fix:** Always append `?__d` to URLs:

```typescript
// In SITE_CONFIG
debugParam: '?__d',  // Always enabled

// In withDebug helper
private withDebug(path: string): string {
    const hasQuery = path.includes('?')
    return path + (hasQuery ? '&__d' : SITE_CONFIG.debugParam)
}
```

### Reports missing cache analysis data

**Cause:** Metrics not being collected properly before page navigation.

**Fix:** Always call `collectPageMetrics` before navigating away:

```typescript
const metrics = await collector.collectPageMetrics('Page Name')
// metrics.cacheAnalysis contains deferred-section (data-manifest-key /
// data-deferred) and page-cache data
// metrics.serverTiming contains loader timings (usually empty — see
// metrics-collector.ts's LoaderTiming doc comment)
```

---

## Playwright Pattern Issues

### Error: "First argument must use object destructuring pattern"

**Cause:** Playwright requires a specific pattern for `test.beforeAll` when accessing `testInfo`.

**Fix:**
```typescript
// Wrong:
test.beforeAll(async (_, testInfo) => { ... })

// Correct:
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires this
test.beforeAll(async ({}, testInfo) => { ... })
```

---

## Environment Issues

### Different results locally vs CI

**Possible causes:**
1. Network speed differences
2. Different screen sizes
3. Timezone/locale issues

**Fixes:**
```typescript
// Set consistent viewport
use: {
    viewport: { width: 1280, height: 720 },
}

// Increase timeouts in CI
timeout: process.env.CI ? 180_000 : 120_000
```

### Tests pass locally but fail in CI

**Common CI fixes:**
```typescript
// In playwright.config.ts
export default defineConfig({
    retries: process.env.CI ? 2 : 0,
    timeout: process.env.CI ? 180_000 : 120_000,
    use: {
        // Slower animations in CI
        launchOptions: {
            slowMo: process.env.CI ? 100 : 0,
        },
    },
})
```
