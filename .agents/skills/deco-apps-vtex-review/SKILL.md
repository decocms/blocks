---
name: deco-apps-vtex-review
description: Audit checklist for the VTEX integration in @decocms/apps-vtex (packages/apps-vtex, the TanStack/Next-agnostic port of deco-cx/apps vtex). Covers Set-Cookie propagation (vtexFetchWithCookies → RequestContext → invoke.gen.ts forwardResponseCookies and @decocms/blocks-admin's /deco/invoke), VtexIdclientAutCookie headers (buildAuthCookieHeader), expectedOrderFormSections, salesChannel (sc) injection, Intelligent Search session cookies, HttpOnly auth, hooks/transform/schema.org parity with deco-cx/apps, and the validation greps. Load when reviewing or porting apps-vtex code, when the cart empties after add-to-cart, when logged-in calls 401/403, when prices or products are wrong for a sales channel, or when cart responses are missing sections.
---

# VTEX apps-vtex Review & Fix

Comprehensive audit checklist for the VTEX integration in `@decocms/apps-vtex` (source: `packages/apps-vtex/src/` in this repo — formerly the `vtex/` folder of the separate `@decocms/apps-start` package). Use after porting or when debugging issues. Paths below are relative to `packages/apps-vtex/src/`.

## File Structure

```
packages/apps-vtex/src/
├── client.ts              # vtexFetch, vtexFetchWithCookies, vtexCachedFetch, intelligentSearch, vtexIOGraphQL
├── middleware.ts           # extractVtexContext, propagateISCookies
├── invoke.ts               # action declarations parsed by blocks-cli's generate-invoke
├── actions/
│   ├── checkout.ts         # Cart mutations (addItems, updateItems, etc.) + Cart v2 (*V2)
│   ├── auth.ts             # classicSignIn, logout, sendEmailVerification
│   ├── session.ts          # createSession, editSession, deleteSession
│   ├── address.ts          # GraphQL address mutations
│   ├── misc.ts             # notifyMe, sendEvent, submitReview, deletePaymentToken
│   ├── newsletter.ts       # subscribe, updateNewsletterOptIn
│   ├── orders.ts           # cancelOrder
│   ├── profile.ts          # updateProfile, updateAddress
│   ├── wishlist.ts         # addItem, removeItem
│   ├── masterData.ts       # MasterData CRUD (server-side only — never emitted as invoke actions)
│   ├── analytics/
│   └── trigger.ts          # Analytics trigger
├── loaders/
│   ├── cart.ts             # getCart (OrderForm)
│   ├── cart/               # Cart v2 loaders: summary, full, shipping, gifts, attachments
│   ├── catalog.ts          # searchProducts, getCrossSelling, getCategoryTree
│   ├── legacy.ts           # legacyProductDetailsPage, legacyProductList, legacyPLP, legacySuggestions
│   ├── workflow.ts         # workflowProduct, workflowProducts
│   ├── search.ts           # getTopSearches, getProductIdByTerm
│   └── (more)
├── inline-loaders/         # TanStack-compatible loaders for sections
├── hooks/                  # useCart, useUser, useWishlist, createUse* factories, createCart / cartQuery (Cart v2)
└── utils/
    ├── transform.ts        # Canonical VTEX→schema.org mapping
    ├── types.ts            # VTEX API types
    ├── vtexId.ts           # VTEX_AUTH_COOKIE, buildAuthCookieHeader
    ├── segment.ts          # buildSegmentFromCookies, isAnonymous
    ├── intelligentSearch.ts # withDefaultParams, withDefaultFacets
    ├── similars.ts         # withIsSimilarTo
    └── enrichment.ts       # withSimulation
```

## When to load what

| Reference | Load it when |
|---|---|
| [`references/cookie-propagation.md`](./references/cookie-propagation.md) | Cart empties after add-to-cart, `/checkout` opens a fresh order, or you're auditing how `Set-Cookie` reaches the browser (both bridges, the `entries()` collapse pitfall) |
| [`references/auth-cookies.md`](./references/auth-cookies.md) | Logged-in VTEX IO GraphQL calls fail, hardcoded `VtexIdclientAutCookie` strings, or client code trying to read the HttpOnly auth cookie |
| [`references/expected-order-form-sections.md`](./references/expected-order-form-sections.md) | OrderForm comes back missing totals/shipping/etc. — the sections list and where it must be sent |
| [`references/sales-channel.md`](./references/sales-channel.md) | Wrong prices, ORD027, or products invisible for a sales channel — where `sc` is injected |
| [`references/intelligent-search-cookies.md`](./references/intelligent-search-cookies.md) | Intelligent Search results/personalization off — `vtex_is_session` / `vtex_is_anonymous` |
| [`references/deco-cx-apps-parity.md`](./references/deco-cx-apps-parity.md) | Checking hooks, `transform.ts` exports and PDP/PLP schema.org shapes against deco-cx/apps |

## Audit checklist (one line each — details in the references)

1. **Cookie propagation** — mutations use `vtexFetchWithCookies`; both bridges copy with `getSetCookie()`.
2. **Auth cookie headers** — `buildAuthCookieHeader` sends both cookie variants; no hardcoded names.
3. **expectedOrderFormSections** — every OrderForm POST sends the sections list.
4. **salesChannel** — `sc` on every checkout/catalog/autocomplete call.
5. **Intelligent Search cookies** — generated when missing and passed to `intelligentSearch()`.
6. **HttpOnly** — auth status comes from `/api/sessions`, never `document.cookie`.
7–9. **Parity** — hooks, `transform.ts`, schema.org page shapes match deco-cx/apps.
10. **No debug logs in production** — see below.

## 10. No Debug Logs in Production

```bash
rg "console\.log" packages/apps-vtex/src/ --glob '*.ts'
```

Only acceptable: 1x startup log in `client.ts`. All others should be `console.error` or `console.warn` in catch blocks.

## Validation

After all fixes, run:

```bash
# TypeScript (from the repo root)
bun run typecheck

# No hardcoded cookie strings
rg "VtexIdclientAutCookie" packages/apps-vtex/src/ --glob '!**/utils/vtexId.ts' --glob '!*.md'

# No debug logs
rg "console\.log" packages/apps-vtex/src/ --glob '*.ts' --glob '!client.ts'

# No trailing whitespace
rg "\s+$" packages/apps-vtex/src/ --glob '*.ts'
```

All must return 0 results (except TypeScript which exits 0). Original standalone-package form of the TypeScript check: `npx -p typescript tsc --noEmit`.
