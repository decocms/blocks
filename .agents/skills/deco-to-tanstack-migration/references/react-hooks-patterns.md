# React Hooks Patterns

> useEffect anti-patterns, useQuery, useMemo, lazy useState, Rules of Hooks.


## 2. useEffect Doesn't Run on Server

Components relying on `useEffect` to populate state will render empty on SSR.

**Fix**: Use TanStack route loaders or section loaders for server-side data.


## 33. usePartialSection is a No-Op

**Severity**: HIGH — tab switching, filter toggling, any partial section re-render breaks silently

Deco's `usePartialSection` hook re-renders a section with new props by making a server request for just that section's HTML. In the React port, this mechanism doesn't exist — `usePartialSection` returns empty data attributes.

**Symptom**: Tabbed product shelves only show the first tab. Clicking other tabs does nothing. Filter visibility toggles don't work. Any component using `usePartialSection` for dynamic props appears frozen.

**Fix**: Replace with React `useState` for client-side state switching. If all tab data is already loaded server-side (common for tabbed shelves where the loader fetches all tabs), just switch between the data client-side:

```typescript
// Before: relies on usePartialSection to re-render with new tabIndex
<button {...usePartialSection({ props: { tabIndex: i } })}>

// After: React state-driven tab switching
const [activeTab, setActiveTab] = useState(0);
<button onClick={() => setActiveTab(i)}>
// Then render tabs[activeTab].products instead of tabs[tabIndex].products
```

For filter toggles, replace `usePartialSection({ props: { openFilter: !openFilter } })` with `useState`:
```typescript
const [openFilter, setOpenFilter] = useState(true);
<button onClick={() => setOpenFilter(!openFilter)}>
```


## 46. useEffect for Client-Side Data Fetching → useQuery

**Severity**: LOW (correctness) / MEDIUM (UX) — `useEffect` fetches are error-prone, miss loading/error states, and don't cache results.

`useEffect` is correct ONLY for true side effects (localStorage reads, subscriptions, DOM manipulation). For any data fetch that runs client-side, `@tanstack/react-query` (already installed) is the right tool.

**Pattern to replace**:
```tsx
const [loading, setLoading] = useState(true);
const [error, setError] = useState(false);

useEffect(() => {
  if (!condition) { setLoading(true); return; }
  if (dependency) {
    fetch(...)
      .then(res => setError(res.error))
      .catch(console.error)
      .finally(() => setLoading(false));
    return;
  }
  setLoading(false);
}, [condition]);
```

**Replace with**:
```tsx
import { useQuery } from "@tanstack/react-query";

const { isFetching, data } = useQuery({
  queryKey: ["key", dependency],
  queryFn: () => fetch(...),
  enabled: condition && !!dependency,
  staleTime: 0, // use when result should never be cached (e.g. "can user act today?")
});

const loading = isFetching;
const error = data?.error ?? false;
```

**Important distinction**: `useEffect` that reads `localStorage` on mount (once, no fetch) should stay as `useEffect`. Only replace fetches.

**When ops are mixed** (e.g., initial check + later mutation both affect `loading`/`error`): split into separate states:
- `useQuery` owns check-loading/check-error
- `useState` owns action-loading/action-error (spin, submit, etc.)
- Derive the final values: `const loading = canSpinFetching || spinLoading`

**`QueryClientProvider` must be in the tree** — already set in `__root.tsx` via `QueryClient` with `staleTime: 30_000` default.


## 47. useEffect Data Fetches That Should NOT Be Replaced with useQuery

**Severity**: LOW — knowing what NOT to touch is as important as knowing what to replace.

After auditing all `useEffect` data fetches in a migrated storefront, three categories resist `useQuery`:

### ❌ DOM Side Effects Mixed With Fetch

```tsx
// SponsoredBannerHero.tsx — fetch result triggers createRoot + DOM events
useEffect(() => {
  invoke.site.loaders.sponsoredTopsort.sponsoredTopsort(params)
    .then(response => {
      createRoot(slot).render(<HeroContent banner={hero} />); // imperative DOM
      root.dispatchEvent(new CustomEvent("sliderGoToIndex", ...));
    });
  return () => { createRoot(slot).render(null); }; // cleanup
}, [query, rootId, ...]);
```

The effect has cleanup logic and imperative DOM manipulation. `useQuery` only manages data — the DOM side effects still need `useEffect`. Refactoring would require separating fetch from DOM manipulation, which changes the architecture. Leave as-is.

### ❌ Paginated / Accumulating Data (generic cursor-based)

```tsx
// MyOrdersListPage.tsx — appends pages, doesn't replace
useEffect(() => {
  getOrderingOrders(currentCursor); // pushes to existing array
}, [currentCursor]);

async function getOrderingOrders(cursor) {
  setOrdersWithStatus(prev => [...prev, ...orders.data.orderingOrders]); // accumulate
}
```

`useQuery` replaces data on each fetch. Accumulation requires `useInfiniteQuery`. Converting is a larger refactor. Leave as-is unless doing a full pagination refactor.

### ✅ "Ver mais" / Load More (Fresh `usePartialSection` pattern)

This is the most common accumulation pattern in migrated storefronts. Fresh used `usePartialSection({ mode: "append" })` to append HTML without reload. In TanStack, use `useLoadMore` from `@decocms/blocks/hooks`:

```tsx
// BEFORE (Fresh)
export default function ProductGallery({ page }: Props) {
  const products = page?.products ?? []
  return (
    <>
      {products.map(p => <ProductCard key={p.productID} product={p} />)}
      {page?.pageInfo?.nextPage && (
        <a href={page.pageInfo.nextPage} {...usePartialSection({ mode: "append" })}>
          Ver mais
        </a>
      )}
    </>
  )
}
```

```tsx
// AFTER (TanStack) — add "use client" at the top
"use client"
import { useLoadMore } from "@decocms/blocks/hooks"

interface Props { page?: ProductListingPage; pageUrl?: string }

export default function ProductGallery({ page, pageUrl }: Props) {
  // Pass pageUrl as resetKey so accumulated pages clear when the user changes
  // filters or sort (which changes the URL and triggers a new server render).
  const { pages, loadMore, loading, hasMore, error } = useLoadMore(
    page ?? { products: [], pageInfo: {} },
    "apps/vtex.ts/loaders/intelligentSearch/productListingPage.ts",
    pageUrl // resetKey
  )
  const products = pages.flatMap(p => p.products ?? [])

  return (
    <>
      {products.map(p => <ProductCard key={p.productID} product={p} />)}
      {error && <p>Erro ao carregar mais produtos.</p>}
      {hasMore && (
        <button onClick={loadMore} disabled={loading}>
          {loading ? "Carregando..." : "Ver mais"}
        </button>
      )}
    </>
  )
}
```

`useLoadMore` returns `{ pages, loadMore, loading, hasMore, error }` and calls `POST /deco/invoke` passing the `nextPage` URL as `__pageUrl`, so the loader correctly reconstructs query, sort, and all active filter params — no state is lost between pages. The loader key is the apps import path for the loader that populates `props.page`.

**`resetKey`**: pass any value that changes when the search context changes (e.g. the page URL). When `resetKey` changes, accumulated pages reset to `[initial]`. Without it, use `key={pageUrl}` on the section element instead — both approaches work, `resetKey` is more ergonomic when the section is rendered by the CMS and you can't easily control `key`.

### ❌ useReducer State (Complex Orchestration)

```tsx
// OurStores.tsx — all state managed via dispatch
useEffect(() => {
  dispatch({ type: "SET_LOADING", payload: true });
  invoke.site.actions.getStores()
    .then(data => dispatch({ type: "SET_ALL_STORES", payload: data }))
    .finally(() => dispatch({ type: "SET_LOADING", payload: false }));
}, []);
```

`useQuery` provides its own loading/data/error state. Integrating it with `useReducer` requires syncing query state → reducer state via another `useEffect`, which defeats the purpose. Options: (1) leave as-is, (2) migrate the whole component from `useReducer` to query + local `useState`.

---

**Rule of thumb**: Replace `useEffect` with `useQuery` only when the ONLY job of the effect is "fetch data → set state". If the effect also mutates the DOM, accumulates into existing state, or is tightly coupled to `useReducer`, leave it alone.