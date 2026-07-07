import type { Page, CDPSession, Response, Request } from '@playwright/test'

export interface PerformanceMetrics {
    LCP: number | null
    FCP: number | null
    CLS: number | null
    TTFB: number | null
    domContentLoaded: number | null
}

export interface NetworkMetrics {
    totalRequests: number
    totalBytes: number
    totalBytesFormatted: string
    slowestRequests: Array<{ url: string; duration: number; type: string }>
    failedRequests: number
}

/**
 * Cache decision vocabulary as actually emitted by the current runtime
 * (`packages/runtime/src/middleware/observability.ts`'s `CacheDecision`
 * type, used by `packages/runtime/src/sdk/cachedLoader.ts`). NOT the old
 * lowercase `hit`/`miss`/`stale`/`bypass` set older versions of this
 * template assumed.
 */
export type CacheStatus = 'HIT' | 'STALE-HIT' | 'STALE-ERROR' | 'MISS' | 'BYPASS'

/**
 * Individual loader timing parsed from a `Server-Timing` header entry.
 *
 * IMPORTANT — read before assuming this is populated: as of 2026-07, no
 * call site in `packages/tanstack` or `packages/next` ever calls
 * `state.timings.start(...)` / `.record(...)` (the `ServerTimings` API in
 * `packages/runtime/src/sdk/serverTimings.ts` that actually feeds the
 * `Server-Timing` HTTP header via `applyServerTiming()`). `buildDecoState`
 * itself is only referenced from its own definition and a doc-comment
 * example in `packages/runtime/src/middleware/index.ts` — it isn't wired
 * into any current site's request pipeline. The real per-loader cache
 * decision (HIT / STALE-HIT / STALE-ERROR / MISS / BYPASS) is recorded via
 * `recordLoaderMetric()` / `recordCacheMetric()` in
 * `packages/runtime/src/middleware/observability.ts`, called from
 * `packages/runtime/src/sdk/cachedLoader.ts` — but those push to an OTel
 * meter (counters/histograms), not the HTTP response, so they are NOT
 * visible to Playwright at all.
 *
 * This type and its parsing logic are kept because the `Server-Timing`
 * header mechanism itself is real (a site's own middleware could opt in
 * following the JSDoc example in `middleware/index.ts`), but expect
 * `loaders` to normally be empty. See `ServerTimingMetrics.headerPresent`.
 */
export interface LoaderTiming {
    name: string
    duration: number
    status: CacheStatus | string | null
}

/**
 * Server-side timing metrics parsed from a page's `Server-Timing` response
 * header (sent via Deco's `?__d` debug mode). See the `LoaderTiming` doc
 * comment above — this is normally empty in the current runtime because
 * nothing populates per-loader entries by default.
 */
export interface ServerTimingMetrics {
    loaders: LoaderTiming[]
    totalServerTime: number
    slowestLoaders: LoaderTiming[]
    cacheStats: {
        total: number
        hit: number
        staleHit: number
        staleError: number
        miss: number
        bypass: number
    }
    /**
     * Whether a non-empty `Server-Timing` header was present on the page's
     * main document response at all. Distinguishes "no header sent" from
     * "header sent but had zero entries" so downstream reporting can be
     * honest about which case it's in instead of always printing the same
     * blank state.
     */
    headerPresent: boolean
}

/**
 * Timing for one deferred/lazy section, tracked via the DOM
 * `data-manifest-key` / `data-deferred` attributes rendered by
 * `DecoPageRenderer` (TanStack) or `SectionRenderer`/`DeferredSection`
 * (Next.js) — see SKILL.md's "Lazy Section Tracking" section.
 *
 * There is no per-section HTTP request in the current architecture
 * (deferred sections stream inline via SSR Suspense on both frameworks in
 * the common case), so this is a DOM-mutation-timing signal, not an
 * HTTP-timing signal like the old `/deco/render`-based tracking used to
 * produce. `duration` is sampled by polling the DOM roughly every 100ms
 * while `scrollPage()` runs, so treat it as an approximation (±100-500ms),
 * not an exact measurement.
 */
export interface DeferredSectionTiming {
    /** The section's registry key, e.g. `site/sections/Hero.tsx`. */
    manifestKey: string
    /** True once `data-deferred` has been removed from the element. */
    resolved: boolean
    /**
     * Approximate ms between first observing the section as
     * `data-deferred="true"` and observing the attribute removed.
     * `null` if the section never became visible as deferred (e.g. it
     * rendered synchronously) or is still pending at collection time.
     */
    duration: number | null
}

/**
 * Page cache analysis
 */
export interface CacheAnalysis {
    pageUrl: string
    pageCached: boolean
    pageCacheControl: string | null
    /** All sections carrying `data-manifest-key` found in the DOM at collection time. */
    deferredSections: DeferredSectionTiming[]
    deferredSectionsResolved: number
    deferredSectionsPending: number
    serverSideLoaders: LoaderTiming[]
    warnings: string[]
}

export interface PageMetrics {
    url: string
    pageName: string
    timestamp: string
    performance: PerformanceMetrics
    network: NetworkMetrics
    serverTiming: ServerTimingMetrics
    cacheAnalysis: CacheAnalysis
    renderTime: number
    errors: string[]
}

interface NetworkEntry {
    url: string
    type: string
    startTime: number
    endTime?: number
    size: number
    status?: number
}

/**
 * Metrics collector for Deco e2e tests.
 *
 * Captures browser Web Vitals, network activity, page-level cache status,
 * an optional `Server-Timing` breakdown (see `LoaderTiming` doc comment —
 * usually empty in the current runtime), and deferred/lazy section
 * resolution tracked via DOM `data-manifest-key` / `data-deferred`
 * attributes (see SKILL.md's "Lazy Section Tracking" section — there is no
 * `/deco/render` per-section network request to observe anymore).
 */
export class MetricsCollector {
    private page: Page
    private cdp: CDPSession | null = null
    private requests = new Map<string, NetworkEntry>()
    private errors: string[] = []
    private startTime = 0
    private serverTimingHeader: string | null = null
    private serverTimingHeaderPresent = false
    private pageCacheControl: string | null = null
    // Deferred-section DOM tracking: first time a manifestKey was observed
    // with data-deferred="true", and (once resolved) how long it took.
    private sectionFirstSeenPending = new Map<string, number>()
    private sectionDurations = new Map<string, number>()

    constructor(page: Page) {
        this.page = page
    }

    async init(): Promise<void> {
        // CDP for performance metrics
        this.cdp = await this.page.context().newCDPSession(this.page)
        await this.cdp.send('Performance.enable')

        // Track network
        this.page.on('request', (req: Request) => {
            this.requests.set(req.url() + Date.now(), {
                url: req.url(),
                type: req.resourceType(),
                startTime: Date.now(),
                size: 0,
            })
        })

        this.page.on('response', async (res: Response) => {
            const url = res.request().url()
            const id = [...this.requests.keys()].find(k =>
                this.requests.get(k)?.url === url &&
                !this.requests.get(k)?.endTime
            )
            if (id) {
                const entry = this.requests.get(id)!
                entry.endTime = Date.now()
                entry.status = res.status()
                try {
                    const body = await res.body().catch(() => null)
                    entry.size = body?.length || parseInt(res.headers()['content-length'] || '0', 10)
                } catch {}
            }

            const headers = res.headers()

            // Capture Server-Timing header from main document response.
            // See the LoaderTiming doc comment: normally absent/empty today.
            if (res.request().resourceType() === 'document') {
                const serverTiming = headers['server-timing']
                this.serverTimingHeaderPresent = Boolean(serverTiming)
                if (serverTiming) {
                    this.serverTimingHeader = serverTiming
                }
                this.pageCacheControl = headers['cache-control'] || null
            }
        })

        this.page.on('requestfailed', (req: Request) => {
            const url = req.url()
            const id = [...this.requests.keys()].find(k =>
                this.requests.get(k)?.url === url && !this.requests.get(k)?.endTime
            )
            if (id) {
                const entry = this.requests.get(id)!
                entry.endTime = Date.now()
                entry.status = 0
            }
        })

        // Track errors
        this.page.on('console', (msg) => {
            if (msg.type() === 'error') this.errors.push(msg.text())
        })
        this.page.on('pageerror', (err) => this.errors.push(err.message))
    }

    private isCached(cacheControl: string | null, status: number): boolean {
        if (status === 304) return true
        if (!cacheControl) return false

        const hasMaxAge = /max-age=\d+/.test(cacheControl) && !/max-age=0/.test(cacheControl)
        const hasSMaxAge = /s-maxage=\d+/.test(cacheControl)
        const noStore = /no-store/.test(cacheControl)
        const noCache = /no-cache/.test(cacheControl)

        return (hasMaxAge || hasSMaxAge) && !noStore && !noCache
    }

    // ─────────────────────────────────────────────────────────────────
    // Deferred/lazy section tracking (DOM-based — see SKILL.md's
    // "Lazy Section Tracking" section for why this replaced the old
    // /deco/render network-request tracking).
    // ─────────────────────────────────────────────────────────────────

    /** All manifest keys currently present in the DOM (resolved or pending). */
    private async getManifestKeys(): Promise<string[]> {
        return this.page.locator('[data-manifest-key]')
            .evaluateAll(els => els
                .map(el => el.getAttribute('data-manifest-key'))
                .filter((k): k is string => Boolean(k)))
            .catch(() => [])
    }

    /** Manifest keys currently still showing a skeleton (data-deferred="true"). */
    private async getPendingDeferredKeys(): Promise<string[]> {
        return this.page.locator('[data-deferred="true"]')
            .evaluateAll(els => els
                .map(el => el.getAttribute('data-manifest-key'))
                .filter((k): k is string => Boolean(k)))
            .catch(() => [])
    }

    /**
     * Poll the DOM and update `sectionFirstSeenPending` / `sectionDurations`.
     * Call this regularly (the scroll loop already polls every ~100ms) so
     * `DeferredSectionTiming.duration` approximates how long each section
     * stayed in the deferred state.
     */
    private async updateSectionTimings(): Promise<void> {
        const pendingKeys = await this.getPendingDeferredKeys()
        const pendingSet = new Set(pendingKeys)
        const now = Date.now()

        for (const key of pendingKeys) {
            if (!this.sectionFirstSeenPending.has(key)) {
                this.sectionFirstSeenPending.set(key, now)
            }
        }

        for (const [key, firstSeen] of this.sectionFirstSeenPending) {
            if (!pendingSet.has(key) && !this.sectionDurations.has(key)) {
                this.sectionDurations.set(key, now - firstSeen)
            }
        }
    }

    /**
     * Wait for a specific section to resolve (its `data-deferred` attribute
     * to disappear). Direct port of the pattern documented in SKILL.md.
     * Returns the wait duration, or `null` if it timed out still deferred.
     */
    async waitForSectionLoaded(manifestKey: string, timeout = 8000): Promise<number | null> {
        const start = Date.now()
        try {
            await this.page.waitForFunction(
                (key) => {
                    const el = document.querySelector(`[data-manifest-key="${key}"]`)
                    return el !== null && !el.hasAttribute('data-deferred')
                },
                manifestKey,
                { timeout },
            )
            return Date.now() - start
        } catch {
            return null
        }
    }

    /** Poll until no sections are pending, or maxWait elapses. Returns remaining pending count. */
    private async waitForPendingDeferred(maxWait: number): Promise<number> {
        const start = Date.now()
        await this.updateSectionTimings()
        let pending = (await this.getPendingDeferredKeys()).length

        while (pending > 0 && Date.now() - start < maxWait) {
            await this.page.waitForTimeout(100)
            await this.updateSectionTimings()
            pending = (await this.getPendingDeferredKeys()).length
        }

        if (pending > 0) {
            console.log(`      ⚠️  Timeout waiting for ${pending} section(s) to resolve`)
        }
        return pending
    }

    startMeasurement(): void {
        this.requests.clear()
        this.errors = []
        this.serverTimingHeader = null
        this.serverTimingHeaderPresent = false
        this.pageCacheControl = null
        this.sectionFirstSeenPending.clear()
        this.sectionDurations.clear()
        this.startTime = Date.now()
    }

    /**
     * Dismiss any popups/modals that might block scrolling
     */
    private async dismissPopups(): Promise<void> {
        await this.page.evaluate(() => {
            document.querySelectorAll('[class*="pushnews"], [id*="pushnews"], [class*="pn-"]').forEach(el => el.remove())

            document.querySelectorAll('button').forEach(btn => {
                const text = btn.textContent || ''
                if (text.includes('obrigado') || text.includes('quero') || text.includes('Aceitar')) {
                    let parent = btn.parentElement
                    for (let i = 0; i < 10 && parent; i++) {
                        const style = window.getComputedStyle(parent)
                        if (style.position === 'fixed' || style.position === 'absolute') {
                            parent.remove()
                            break
                        }
                        parent = parent.parentElement
                    }
                }
            })
        }).catch(() => {})
    }

    /**
     * Scroll down the page to trigger lazy/deferred sections into view and
     * wait for them to resolve (data-deferred to disappear) before
     * continuing. Returns the number of sections that newly resolved
     * during this call.
     */
    async scrollPage(options: { full?: boolean; footerSelector?: string; maxTime?: number } = {}): Promise<number> {
        const { full = false, footerSelector = 'footer', maxTime = 30000 } = options
        const startTime = Date.now()

        await this.updateSectionTimings()
        const initialResolved = (await this.getManifestKeys()).length - (await this.getPendingDeferredKeys()).length

        await this.page.waitForTimeout(1000)
        await this.dismissPopups()

        if (!full) {
            for (let i = 0; i < 3; i++) {
                await this.page.evaluate(() => window.scrollBy(0, 500)).catch(() => {})
                await this.page.waitForTimeout(300)
            }
            await this.waitForPendingDeferred(3000)
            return this.countNewlyResolved(initialResolved)
        }

        const scrollStep = 200
        let stuckSectionCount = 0
        const maxStuckSections = 2

        for (let i = 0; i < 300; i++) {
            if (this.page.isClosed()) break

            const elapsed = Date.now() - startTime
            if (elapsed > maxTime) {
                console.log(`      ⏱️  Scroll timeout (${Math.round(elapsed / 1000)}s) - stopping`)
                break
            }

            await this.updateSectionTimings()
            const pendingKeys = await this.getPendingDeferredKeys()

            if (pendingKeys.length > 0) {
                console.log(`      ⏳ Waiting for ${pendingKeys.length} pending section(s) before next scroll...`)
                const stillPending = await this.waitForPendingDeferred(8000)

                if (stillPending > 0) {
                    stuckSectionCount++
                    console.log(`      ⚠️  Section(s) STUCK (${stuckSectionCount}/${maxStuckSections}) - will skip`)

                    if (stuckSectionCount >= maxStuckSections) {
                        console.log(`      🛑 Too many stuck sections - stopping scroll`)
                        break
                    }

                    await this.page.waitForTimeout(1000)
                }

                await this.page.waitForTimeout(500)
                continue
            }

            const footerVisible = await this.page.locator(footerSelector).first().isVisible().catch(() => false)
            if (footerVisible) {
                console.log(`      ✅ Footer visible after ${i} scrolls`)
                break
            }

            if (i < 5) await this.dismissPopups()

            await this.page.evaluate((step) => window.scrollBy(0, step), scrollStep).catch(() => {})
            await this.page.waitForTimeout(100)

            const atBottom = await this.page.evaluate(() => {
                return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 20
            }).catch(() => false)

            if (atBottom) {
                await this.waitForPendingDeferred(3000)

                const footerNow = await this.page.locator(footerSelector).first().isVisible().catch(() => false)
                console.log(footerNow ? `      ✅ Footer visible at bottom` : `      ⚠️  At bottom, no footer`)
                break
            }
        }

        await this.updateSectionTimings()
        return this.countNewlyResolved(initialResolved)
    }

    private async countNewlyResolved(initialResolved: number): Promise<number> {
        const allKeys = await this.getManifestKeys()
        const pendingKeys = await this.getPendingDeferredKeys()
        const resolvedNow = allKeys.length - pendingKeys.length
        return Math.max(0, resolvedNow - initialResolved)
    }

    async collectPageMetrics(pageName: string): Promise<PageMetrics> {
        if (this.page.isClosed()) {
            console.log('      ⚠️  Page was closed before collecting metrics')
            return this.getEmptyMetrics(pageName)
        }

        await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
        if (this.page.isClosed()) return this.getEmptyMetrics(pageName)
        await this.page.waitForTimeout(500).catch(() => {})
        await this.updateSectionTimings()

        const serverTiming = this.parseServerTiming()
        const cacheAnalysis = await this.analyzeCaching(serverTiming)

        return {
            url: this.page.url(),
            pageName,
            timestamp: new Date().toISOString(),
            performance: await this.getPerformance(),
            network: this.getNetwork(),
            serverTiming,
            cacheAnalysis,
            renderTime: Date.now() - this.startTime,
            errors: [...this.errors],
        }
    }

    private async getDeferredSectionTimings(): Promise<DeferredSectionTiming[]> {
        const allKeys = [...new Set(await this.getManifestKeys())]
        const pendingKeys = new Set(await this.getPendingDeferredKeys())

        return allKeys.map(manifestKey => ({
            manifestKey,
            resolved: !pendingKeys.has(manifestKey),
            duration: this.sectionDurations.get(manifestKey) ?? null,
        }))
    }

    private async analyzeCaching(serverTiming: ServerTimingMetrics): Promise<CacheAnalysis> {
        const warnings: string[] = []
        const pageCached = this.isCached(this.pageCacheControl, 200)

        const deferredSections = await this.getDeferredSectionTimings()
        const deferredSectionsResolved = deferredSections.filter(s => s.resolved).length
        const deferredSectionsPending = deferredSections.filter(s => !s.resolved).length

        const serverSideLoaders = serverTiming.slowestLoaders.filter(l => l.duration > 0)

        if (!pageCached && serverSideLoaders.length > 0) {
            const slowLoaders = serverSideLoaders.filter(l => l.duration > 50)
            if (slowLoaders.length > 0) {
                warnings.push(
                    `⚠️ Page is NOT cached but has ${slowLoaders.length} slow loader(s) on SSR. ` +
                    `Consider moving loaders to lazy sections or adding cache.`
                )
            }
        }

        if (serverSideLoaders.length > 10) {
            warnings.push(
                `⚠️ ${serverSideLoaders.length} loaders running on SSR. ` +
                `Consider lazy loading more sections.`
            )
        }

        if (deferredSectionsPending > 0) {
            warnings.push(
                `⚠️ ${deferredSectionsPending} deferred section(s) still showed data-deferred="true" ` +
                `when metrics were collected. Consider a longer scrollPage maxTime or investigate slow sections.`
            )
        }

        const verySlowLoaders = serverSideLoaders.filter(l => l.duration > 200)
        if (verySlowLoaders.length > 0) {
            warnings.push(
                `🐢 ${verySlowLoaders.length} very slow loader(s) (>200ms) on SSR: ` +
                verySlowLoaders.map(l => `${l.name} (${l.duration}ms)`).join(', ')
            )
        }

        return {
            pageUrl: this.page.url(),
            pageCached,
            pageCacheControl: this.pageCacheControl,
            deferredSections,
            deferredSectionsResolved,
            deferredSectionsPending,
            serverSideLoaders,
            warnings,
        }
    }

    private parseServerTiming(): ServerTimingMetrics {
        return this.parseServerTimingToMetrics(this.serverTimingHeader)
    }

    private parseServerTimingToMetrics(header: string | null): ServerTimingMetrics {
        const loaders: LoaderTiming[] = []
        const cacheStats = { total: 0, hit: 0, staleHit: 0, staleError: 0, miss: 0, bypass: 0 }

        if (!header) {
            return {
                loaders: [],
                totalServerTime: 0,
                slowestLoaders: [],
                cacheStats,
                headerPresent: this.serverTimingHeaderPresent,
            }
        }

        const entries = header.split(/,\s*/)

        for (const entry of entries) {
            const parsed = this.parseServerTimingEntry(entry.trim())
            if (parsed) {
                loaders.push(parsed)
                cacheStats.total++

                // Real vocabulary per `CacheDecision`
                // (packages/runtime/src/middleware/observability.ts):
                // HIT | STALE-HIT | STALE-ERROR | MISS | BYPASS.
                switch (parsed.status) {
                    case 'HIT': cacheStats.hit++; break
                    case 'STALE-HIT': cacheStats.staleHit++; break
                    case 'STALE-ERROR': cacheStats.staleError++; break
                    case 'MISS': cacheStats.miss++; break
                    case 'BYPASS': cacheStats.bypass++; break
                    default: break
                }
            }
        }

        const totalServerTime = loaders
            .filter(l => l.name !== 'render-to-string')
            .reduce((sum, l) => sum + l.duration, 0)

        const slowestLoaders = [...loaders]
            .filter(l => !['router', 'render-to-string', 'load-data', 'cfExtPri'].includes(l.name))
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 10)

        return {
            loaders,
            totalServerTime,
            slowestLoaders,
            cacheStats,
            headerPresent: this.serverTimingHeaderPresent,
        }
    }

    private parseServerTimingEntry(entry: string): LoaderTiming | null {
        if (!entry) return null

        const parts = entry.split(';')
        if (parts.length === 0) return null

        const rawName = parts[0]
        const name = this.decodeLoaderName(rawName)

        let duration = 0
        let status: string | null = null

        for (let i = 1; i < parts.length; i++) {
            const part = parts[i].trim()
            if (part.startsWith('dur=')) {
                duration = parseFloat(part.substring(4)) || 0
            } else if (part.startsWith('desc=')) {
                status = part.substring(5).replace(/^"|"$/g, '')
            }
        }

        return { name, duration, status }
    }

    private decodeLoaderName(raw: string): string {
        try {
            let decoded = decodeURIComponent(raw)
            try {
                decoded = decodeURIComponent(decoded)
            } catch {}

            decoded = decoded
                .replace(/@/g, ' → ')
                .replace(/\.variants\.\d+\.value\./g, '.')
                .replace(/\.section\./g, '.')
                .replace(/pages-/g, '')
                .replace(/-[a-f0-9]{8,}/g, '')

            return decoded
        } catch {
            return raw
        }
    }

    private async getPerformance(): Promise<PerformanceMetrics> {
        const data = await this.page.evaluate(() => {
            const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
            const fcp = performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint')
            const lcpEntries = performance.getEntriesByType('largest-contentful-paint')
            const lcp = lcpEntries[lcpEntries.length - 1] as PerformanceEntry & { startTime: number }

            const layoutShifts = performance.getEntriesByType('layout-shift') as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>
            const cls = layoutShifts.filter(e => !e.hadRecentInput).reduce((sum, e) => sum + e.value, 0)

            return {
                TTFB: nav?.responseStart - nav?.requestStart || null,
                domContentLoaded: nav?.domContentLoadedEventEnd - nav?.startTime || null,
                FCP: fcp?.startTime || null,
                LCP: lcp?.startTime || null,
                CLS: cls,
            }
        })

        return {
            TTFB: data.TTFB,
            FCP: data.FCP,
            LCP: data.LCP,
            CLS: data.CLS,
            domContentLoaded: data.domContentLoaded,
        }
    }

    private getNetwork(): NetworkMetrics {
        const entries = [...this.requests.values()]
        const totalBytes = entries.reduce((sum, e) => sum + e.size, 0)

        const slowest = entries
            .filter(e => e.endTime)
            .map(e => ({
                url: e.url.slice(0, 80),
                duration: (e.endTime || 0) - e.startTime,
                type: e.type,
            }))
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 5)

        return {
            totalRequests: entries.length,
            totalBytes,
            totalBytesFormatted: this.formatBytes(totalBytes),
            slowestRequests: slowest,
            failedRequests: entries.filter(e => e.status === 0).length,
        }
    }

    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B'
        const k = 1024
        const sizes = ['B', 'KB', 'MB']
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
    }

    async cleanup(): Promise<void> {
        await this.cdp?.detach().catch(() => {})
    }

    private getEmptyMetrics(pageName: string): PageMetrics {
        return {
            url: 'page-closed',
            pageName,
            timestamp: new Date().toISOString(),
            performance: { LCP: null, FCP: null, CLS: null, TTFB: null, domContentLoaded: null },
            network: { totalRequests: 0, totalBytes: 0, totalBytesFormatted: '0 B', slowestRequests: [], failedRequests: 0 },
            serverTiming: {
                loaders: [],
                totalServerTime: 0,
                slowestLoaders: [],
                cacheStats: { total: 0, hit: 0, staleHit: 0, staleError: 0, miss: 0, bypass: 0 },
                headerPresent: false,
            },
            cacheAnalysis: {
                pageUrl: 'page-closed',
                pageCached: false,
                pageCacheControl: null,
                deferredSections: [],
                deferredSectionsResolved: 0,
                deferredSectionsPending: 0,
                serverSideLoaders: [],
                warnings: ['Page was closed before metrics collection'],
            },
            renderTime: 0,
            errors: ['Page was closed'],
        }
    }
}

/**
 * Format loader timings for console output.
 *
 * NOTE: as documented on `LoaderTiming`, the current TanStack/Next.js
 * middleware doesn't wire per-loader Server-Timing entries by default —
 * `serverTiming.loaders` will normally be empty. This prints an explicit
 * "no data" line in that case rather than fabricating a table.
 */
export function formatLoaderTimings(serverTiming: ServerTimingMetrics): string[] {
    const lines: string[] = []

    if (serverTiming.loaders.length === 0) {
        if (serverTiming.headerPresent) {
            lines.push('   ⚡ Server Timing: header present but no parsable loader entries')
        } else {
            lines.push('   ⚡ Server Timing: no per-loader data (this runtime doesn\'t wire loader-level Server-Timing entries by default — see SKILL.md "Deco Observability Signals")')
        }
        return lines
    }

    const { hit, staleHit, staleError, miss, bypass } = serverTiming.cacheStats
    const cacheInfo: string[] = []
    if (hit > 0) cacheInfo.push(`💾${hit}`)
    if (staleHit > 0) cacheInfo.push(`⏳${staleHit}`)
    if (staleError > 0) cacheInfo.push(`🟠${staleError}`)
    if (miss > 0) cacheInfo.push(`❌${miss}`)
    if (bypass > 0) cacheInfo.push(`⏭️${bypass}`)

    const cacheStr = cacheInfo.length > 0 ? ` [${cacheInfo.join(' ')}]` : ''
    lines.push(`   ⚡ Server Timing: ${serverTiming.totalServerTime.toFixed(0)}ms total (${serverTiming.loaders.length} loaders)${cacheStr}`)

    if (serverTiming.loaders.length > 0) {
        lines.push('   ┌───────────────────────────────────────────────────────────')

        const sorted = [...serverTiming.loaders].sort((a, b) => b.duration - a.duration)

        for (const loader of sorted.slice(0, 12)) {
            const speedIcon = loader.duration < 50 ? '🟢' : loader.duration < 200 ? '🟡' : '🔴'
            let cacheIcon = '  '
            if (loader.status === 'HIT') cacheIcon = '💾'
            else if (loader.status === 'STALE-HIT') cacheIcon = '⏳'
            else if (loader.status === 'STALE-ERROR') cacheIcon = '🟠'
            else if (loader.status === 'MISS') cacheIcon = '❌'
            else if (loader.status === 'BYPASS') cacheIcon = '⏭️'

            const name = loader.name.length > 30 ? loader.name.substring(0, 27) + '...' : loader.name.padEnd(30)
            const status = loader.status ? `[${loader.status}]` : ''

            lines.push(`   │ ${speedIcon} ${name} ${loader.duration.toFixed(0).padStart(5)}ms ${cacheIcon} ${status}`)
        }

        if (serverTiming.loaders.length > 12) {
            lines.push(`   │ ... and ${serverTiming.loaders.length - 12} more loaders`)
        }

        lines.push('   └───────────────────────────────────────────────────────────')
    }

    return lines
}

/**
 * Format deferred/lazy-section analysis for console output.
 *
 * Kept the historical export name (`formatLazyRenderAnalysis`) to avoid
 * breaking imports, but the data source is now DOM-based
 * (`data-manifest-key` / `data-deferred`), not HTTP `/deco/render`
 * requests — see SKILL.md's "Lazy Section Tracking" section.
 */
export function formatLazyRenderAnalysis(cacheAnalysis: CacheAnalysis): string[] {
    const lines: string[] = []

    const pageIcon = cacheAnalysis.pageCached ? '✅' : '❌'
    lines.push(`   ${pageIcon} Page Cache: ${cacheAnalysis.pageCached ? 'CACHED' : 'NOT CACHED'}`)
    if (cacheAnalysis.pageCacheControl && cacheAnalysis.pageCached) {
        lines.push(`      Cache-Control: ${cacheAnalysis.pageCacheControl.substring(0, 60)}...`)
    }

    if (cacheAnalysis.serverSideLoaders.length > 0) {
        lines.push('')
        lines.push(`   🖥️  SSR Loaders (${cacheAnalysis.serverSideLoaders.length}):`)
        lines.push('   ┌───────────────────────────────────────────────────────────')
        for (const loader of cacheAnalysis.serverSideLoaders.slice(0, 10)) {
            const speedIcon = loader.duration < 50 ? '🟢' : loader.duration < 200 ? '🟡' : '🔴'
            const cacheIcon = loader.status === 'HIT' ? '💾'
                : loader.status === 'STALE-HIT' ? '⏳'
                : loader.status === 'STALE-ERROR' ? '🟠'
                : loader.status === 'MISS' ? '❌'
                : '⏭️'
            const name = loader.name.length > 30 ? loader.name.substring(0, 27) + '...' : loader.name.padEnd(30)
            const status = loader.status ? `[${loader.status}]` : ''
            lines.push(`   │ ${speedIcon} ${name} ${loader.duration.toString().padStart(4)}ms ${cacheIcon} ${status}`)
        }
        if (cacheAnalysis.serverSideLoaders.length > 10) {
            lines.push(`   │ ... and ${cacheAnalysis.serverSideLoaders.length - 10} more loaders`)
        }
        lines.push('   └───────────────────────────────────────────────────────────')
    }

    if (cacheAnalysis.deferredSections.length > 0) {
        lines.push('')
        lines.push(`   🔄 Deferred Sections (${cacheAnalysis.deferredSections.length}):`)
        lines.push('   ┌───────────────────────────────────────────────────────────')

        const sorted = [...cacheAnalysis.deferredSections].sort((a, b) => (b.duration ?? -1) - (a.duration ?? -1))

        for (const section of sorted.slice(0, 15)) {
            const duration = section.duration
            const speedIcon = duration === null ? '⏳' : duration < 100 ? '🟢' : duration < 500 ? '🟡' : '🔴'
            const statusIcon = section.resolved ? '✅' : '⏳'
            const durationText = duration === null ? (section.resolved ? 'n/a' : 'pending').padStart(7) : `${duration.toString().padStart(5)}ms`
            const name = section.manifestKey.length > 26 ? section.manifestKey.substring(0, 23) + '...' : section.manifestKey.padEnd(26)

            lines.push(`   │ ${speedIcon} ${name} ${durationText} ${statusIcon}`)
        }

        if (cacheAnalysis.deferredSections.length > 15) {
            lines.push(`   │ ... and ${cacheAnalysis.deferredSections.length - 15} more sections`)
        }
        lines.push('   └───────────────────────────────────────────────────────────')

        const timed = cacheAnalysis.deferredSections.filter((s): s is DeferredSectionTiming & { duration: number } => s.duration !== null)
        const fast = timed.filter(s => s.duration < 100).length
        const medium = timed.filter(s => s.duration >= 100 && s.duration < 500).length
        const slow = timed.filter(s => s.duration >= 500).length
        const totalTime = timed.reduce((sum, s) => sum + s.duration, 0)

        lines.push(`   📊 Summary: ${fast} fast, ${medium} medium, ${slow} slow │ Total: ${totalTime}ms`)

        if (cacheAnalysis.deferredSectionsPending > 0) {
            lines.push(`   ⚠️  ${cacheAnalysis.deferredSectionsPending} still pending (data-deferred="true") at collection time`)
        }
    }

    if (cacheAnalysis.warnings.length > 0) {
        lines.push('')
        lines.push('   ⚠️  WARNINGS:')
        for (const warning of cacheAnalysis.warnings) {
            lines.push(`      ${warning}`)
        }
    }

    return lines
}

/**
 * Get a summary of loader timings for compact display. See the
 * `LoaderTiming` doc comment — normally empty in the current runtime.
 */
export function getLoaderSummary(serverTiming: ServerTimingMetrics): string {
    if (serverTiming.loaders.length === 0) {
        return serverTiming.headerPresent ? 'Server-Timing header present, no parsable entries' : 'No Server-Timing data (not wired into this runtime by default)'
    }

    const count = serverTiming.loaders.length
    const slowest = serverTiming.slowestLoaders[0]
    const slowestInfo = slowest ? `slowest: ${slowest.name.substring(0, 20)}... (${slowest.duration}ms)` : ''

    return `${count} loaders, ${serverTiming.totalServerTime}ms total${slowestInfo ? ', ' + slowestInfo : ''}`
}
