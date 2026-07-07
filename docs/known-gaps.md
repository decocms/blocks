# Known Gaps vs. deco-cx/deco

Supersedes `GAP_ANALYSIS.md` and `GAP_ANALYSIS_V2.md` (both removed — see git history if you need the full original audits, dated March 2026). Those two documents tracked capability gaps between this framework and the original `deco-cx/deco`; the overwhelming majority of tracked items are now shipped. This file keeps only what's still genuinely open, plus the architectural-rationale table that's still useful context.

**A caution about this list itself:** while extracting it, at least four items the source docs marked "remaining"/"still missing" turned out to already be resolved in the current codebase (RequestContext via AsyncLocalStorage, `LazySection` intersection-observer lazy loading, the decofile hot-reload endpoint's auth-token check, and composable `BlockSource`/`KVBlockSource` decofile providers) — plus a fifth, the dev daemon/tunnel, which the old doc called "deferred" but which now ships as `@decocms/tanstack/daemon`. So treat the items below as a **starting point for verification**, not a guaranteed-accurate open-items list. If you're about to build one of these, grep for it first.

## Still open (as of this doc's writing)

From `GAP_ANALYSIS_V2.md`'s own Part 6 roadmap (Tier 3 — Future/deferred), the most-current of the two source docs:

| Gap | Notes |
|---|---|
| Loader/action schema generation | `@decocms/cli`'s `generate-schema.ts` only generates *section* schemas today. Needs a manifest format design before loader/action schemas can be generated the same way. |
| Admin live-preview (WebSocket) | `/deco/render` already renders a single section on demand; the admin currently polls/refreshes an iframe rather than getting a WebSocket push. Cross-repo effort (needs admin frontend changes too). |
| SSE streaming reader | No streaming-loader support today, so there's nothing to stream from yet. |
| `sectionMiddleware` / `transformProps` | Proposed pattern letting a section export a `transformProps(props)` function that runs server-side before render, for lightweight prop enrichment without a full commerce-loader registration. Would need registry changes in `@decocms/runtime`. |
| Shopify draft order, Shopify proxy routes | Deferred by choice, not blocked — build when a Shopify storefront actually needs them. |
| Geo/location matchers | Needs an IP geolocation service wired in; Cloudflare provides the raw geo data, the matcher itself isn't built. |

From `GAP_ANALYSIS.md` (v1), items not covered by V2's later pass and not independently confirmed done during this cleanup:

| Gap | Notes |
|---|---|
| Early Hints (103) | No resource-preloading hints today. |
| Full OTel SDK auto-instrumentation | Current observability is a pluggable-tracer-adapter model (see `docs/observability.md`), not full OTel auto-instrumentation. |
| OTel metrics (histograms) | No cache hit/miss or latency histograms today. |
| `ReleaseResolver` (lazy/deferred resolution, `runOnce`) | Not ported. |
| Resolve-chain tracing (which block called which) | Not ported. |
| Override maps (runtime resolvable substitution) | Not ported. |
| Platform detection (K8s/Deploy/localhost) | Not ported. |
| Remaining widget types (`Select`, `CheckboxGroup`, `RadioGroup`, `DatePicker`, `NumberRange`, `Dynamic`, custom widget registration) | Only a subset of deco's widget types exist today. |
| Schema-gen: app-dependency merging, incremental/watch mode | `generate-schema.ts` runs full, non-incremental generation with no cross-app dependency merge. |

## Intentional divergences (not gaps — architectural choices)

| deco-cx/deco | This framework | Why it's intentional |
|---|---|---|
| Section exports `loader()` + `action()` | Sections are pure React components | Idiomatic React/TanStack; loaders wired externally via `registerCommerceLoaders()` |
| HTMX partials (`hx-get`, `f-partial`) | TanStack Query + Router navigation | Fits React's reconciliation model; no DOM-swap hacks |
| Fresh islands (selective hydration) | Full React SPA with SSR | TanStack Start's model; `Suspense`/`React.lazy()` for code splitting instead |
| Deno runtime | Node.js on Cloudflare Workers | Deployment target choice |
| Import maps for app composition | npm packages | Standard Node.js package resolution |
| Global `fetch` monkey-patch for request-scoped abort | Explicit `RequestContext.fetch` / instrumented fetch | Predictable — no hidden global behavior change |
| `RequestContext.framework = "htmx"` | Always React | Single rendering framework, no need to branch |
