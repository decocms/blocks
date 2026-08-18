
# Hydration & Navigation Fixes for Deco TanStack Storefronts

Patterns and fixes for hydration mismatches, flash-of-white, CLS, scroll issues, and React warnings discovered in production Deco storefronts running TanStack Start + React 19 + Cloudflare Workers.

## 1. Flash-of-White / Blank Screen on F5

**Symptom**: Page loads, goes blank for a moment, then content reappears.

**Root cause**: `React.lazy` + `<Suspense>` for eager (above-the-fold) sections. Even with `syncThenable` optimization, the module may not be synchronously available during hydration, causing React to show the fallback and discard server HTML.

### Fix: Synchronous Section Registry

Register critical above-the-fold sections with static imports so they never go through `React.lazy`:

```typescript
// site setup.ts
import { registerSectionsSync } from "@decocms/start/cms";
import HeaderSection from "./sections/Header/Header";
import FooterSection from "./sections/Footer/Footer";
import ThemeSection from "./sections/Theme/Theme";

registerSectionsSync({
  "site/sections/Header/Header.tsx": HeaderSection,
  "site/sections/Footer/Footer.tsx": FooterSection,
  "site/sections/Theme/Theme.tsx": ThemeSection,
});
```

In `DecoPageRenderer`, check `getSyncComponent(key)` first. If found, render directly without `<Suspense>`:

```tsx
const SyncComp = getSyncComponent(section.component);
if (SyncComp) {
  return (
    <section id={sectionId} data-manifest-key={section.key}>
      <SyncComp {...section.props} />
    </section>
  );
}
// else fall back to React.lazy
```

**Which sections to register sync**: Header, Footer, Theme, and any section visible on initial viewport (ProductInfo for PDP, SearchResult for PLP).

## 2. Hydration Mismatch from Environment Variables

**Symptom**: Console error `A tree hydrated but some attributes of the server rendered HTML didn't match the client properties` for `__DECO_STATE`.

**Root cause**: `process.env.DECO_SITE_NAME` resolves on the server (from `.env`) but is `undefined` on the client, falling back to a different hardcoded string.

### Fix: Vite `define` for Build-Time Injection

```typescript
// vite.config.ts
export default defineConfig({
  define: {
    "process.env.DECO_SITE_NAME": JSON.stringify(
      process.env.DECO_SITE_NAME || "your-site-name"
    ),
  },
});
```

This replaces `process.env.DECO_SITE_NAME` at build-time in **both** SSR and client bundles, guaranteeing the same value.

**Rule**: Any `process.env.*` used in JSX that renders on both server and client needs a Vite `define` entry. Otherwise, use `import.meta.env.VITE_*` (Vite auto-exposes `VITE_`-prefixed vars to client).

## 3. CLS from Third-Party Scripts

**Symptom**: Large Cumulative Layout Shift (CLS > 0.25) traced to external scripts injecting content.

### Common Offenders

| Script | Problem | Fix |
|--------|---------|-----|
| Raichu/ReclameAqui `bundle.js` | Inline `<script>` loads CSS that shifts layout | Convert to React component, defer with `useEffect` + `requestIdleCallback`, add `minHeight` |
| TrustVox widget | Injects DOM after load | Add `minHeight` on container divs |
| Any analytics/chat widget | Injects floating elements | Reserve space or load after hydration |

### Pattern: Deferred Script Component

```tsx
function DeferredScript({ src, id, dataset, minHeight = 60 }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || document.getElementById(id)) return;
    const load = () => {
      const script = document.createElement("script");
      script.id = id;
      script.async = true;
      script.src = src;
      Object.entries(dataset).forEach(([k, v]) => {
        script.dataset[k] = v;
      });
      ref.current?.appendChild(script);
    };
    if ("requestIdleCallback" in window) {
      requestIdleCallback(load, { timeout: 3000 });
    } else {
      setTimeout(load, 2000);
    }
  }, []);
  return <div ref={ref} id={`${id}-container`} style={{ minHeight }} />;
}
```

## 4. Async Rendering Double-Flash

**Symptom**: Deferred sections show the generic gray skeleton, then replace it with the custom `LoadingFallback`, then show the real content.

**Root cause**: `DeferredSectionWrapper` renders `DefaultSectionFallback` immediately while `preloadSectionModule` fetches the module to discover if a custom `loadingFallback` exists.

### Fix: Wait for Options Before Showing Any Fallback

```tsx
const [optionsReady, setOptionsReady] = useState(
  () => !!getSectionOptions(deferred.component),
);

useEffect(() => {
  if (optionsReady) return;
  preloadSectionModule(deferred.component).then((opts) => {
    if (opts) setLoadedOptions(opts);
    setOptionsReady(true);
  });
}, [deferred.component]);

const skeleton = !optionsReady
  ? null  // render nothing until we know which fallback to show
  : hasCustomFallback
    ? createElement(loadedOptions!.loadingFallback!)
    : <DefaultSectionFallback />;
```

## 5. Scroll-to-Top Inconsistency

**Symptom**: Clicking a product card navigates to PDP but page stays at scroll position of the shelf (near bottom).

**Root cause**: TanStack Router `scrollRestoration: true` has a known bug (#3804) where scroll-to-top doesn't always fire on forward navigation.

### Fix: Manual Scroll-to-Top on Forward Navigation

```typescript
// router.tsx
const router = createTanStackRouter({
  routeTree,
  scrollRestoration: true,
});

if (typeof window !== "undefined") {
  let lastAction: string | undefined;

  router.history.subscribe(({ action }) => {
    lastAction = action.type;
  });

  router.subscribe("onResolved", (evt) => {
    // PUSH/REPLACE = forward nav → scroll top
    // GO = back/forward → let scrollRestoration handle it
    if (evt.pathChanged && lastAction !== "GO") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
}
```

Use `"smooth"` for pleasant UX, `"instant"` if speed is preferred.

## 6. Navigation Loading Feedback

**Symptom**: Clicking a product card gives no visual feedback for several seconds until the page loads.

### Fix: ProductLink Component with Spinner Overlay

```tsx
import { Link, useRouterState } from "@tanstack/react-router";

export default function ProductLink({ children, className, showSpinner = true, ...props }) {
  const targetPath = typeof props.to === "string" ? props.to : "";
  const isNavigating = useRouterState({
    select: (s) => {
      if (!s.isLoading || !targetPath) return false;
      const pending = s.location.pathname;
      const current = s.resolvedLocation?.pathname;
      return pending !== current && pending === targetPath;
    },
  });

  return (
    <Link
      className={`relative ${className ?? ""}${isNavigating ? " pointer-events-none" : ""}`}
      {...props}
    >
      {children}
      {showSpinner && isNavigating && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/60 rounded">
          <span className="loading loading-spinner loading-md text-primary" />
        </div>
      )}
    </Link>
  );
}
```

Replace `<Link>` in product card image areas with `<ProductLink>`. Use `showSpinner={false}` for text areas where the overlay would look odd.

**Complement with NavigationProgress bar** in `__root.tsx` using `useRouterState({ select: s => s.isLoading })`.

## 7. Common React DOM Warnings

| Warning | Cause | Fix |
|---------|-------|-----|
| `fetchpriority` → `fetchPriority` | HTML attr not camelCased | Change to camelCase in JSX |
| `stroke-linecap` → `strokeLinecap` | SVG attr not camelCased | Change to camelCase in JSX |
| `fill-rule` → `fillRule` | SVG attr not camelCased | Change to camelCase in JSX |
| `clip-rule` → `clipRule` | SVG attr not camelCased | Change to camelCase in JSX |
| `class` → `className` | Preact migration leftover | Replace throughout |
| Missing `key` in list | `.map()` without `key` | Add unique `key` prop |
| `value` without `onChange` | Controlled input missing handler | Add `onChange` or use `defaultValue` |
| `selected` on `<option>` | Old HTML pattern | Use `value` on parent `<select>` |

## 8. Performance Trace Recording (Chrome DevTools)

The Chrome Performance recorder is the most powerful tool for diagnosing CLS, hydration flash, and layout shift root causes. It captures exactly **which element shifted**, **by how many pixels**, and **what triggered it**.

### How to Record a Trace

1. Open Chrome DevTools → **Performance** tab
2. Check **Web Vitals** checkbox (bottom of panel) — this enables CLS tracking
3. Check **Screenshots** checkbox — captures visual frames to see the flash
4. Click **Record** (circle button) or press `Ctrl+E`
5. Reproduce the issue: F5 to reload, or navigate to the problematic page
6. Wait for the page to fully load (3-5 seconds)
7. Click **Stop** to end recording

### Reading the Trace for CLS

1. In the trace timeline, look for **red/orange diamonds** labeled "Layout Shift" in the Experience lane
2. Click on a Layout Shift diamond — the **Summary** panel shows:
   - **Score**: the CLS value for that shift (e.g., 0.59)
   - **Cumulative Score**: running total
   - **Elements affected**: the DOM node that moved (e.g., `DIV#ra-verified-seal`)
3. Click the element name to jump to it in the Elements panel
4. Look at **what happened just before** the shift in the timeline: did a script load? a stylesheet? a font?

### Reading the Trace for Flash-of-White

1. Enable **Screenshots** in the recording
2. In the filmstrip at the top, look for white/blank frames between painted frames
3. Hover over the white frame — note the timestamp
4. At that timestamp in the Main thread, look for:
   - **React reconciliation** work (`performConcurrentWorkOnRoot`)
   - **Suspense fallback** activation (the `React.lazy` path)
   - **Hydration** warnings (logged to console at same time)

### Reading the Trace for Slow Navigation

1. Record during a SPA navigation (click a product card)
2. Look at the **Network** waterfall — find the server function call (e.g., `loadCmsPage`)
3. Check the duration — if it's > 1s, the loader is the bottleneck
4. Look at **Main thread** for long tasks blocking the UI after data arrives

### Exporting and Sharing Traces

1. After recording, click the **down arrow** (Export) in the Performance panel
2. Save as `.json` file — this is the full trace with all timing data
3. Share with teammates — they can **Import** it into their DevTools
4. The trace file also works with tools like [Perfetto UI](https://ui.perfetto.dev/)

### Quick CLS Diagnosis Shortcut

Instead of a full trace, use the **Lighthouse** panel:
1. DevTools → **Lighthouse** → check only **Performance**
2. Run on the specific page
3. Scroll to **Diagnostics** → **Avoid large layout shifts**
4. It lists the exact elements and their shift contributions

Or use the browser console:

```javascript
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.hadRecentInput) continue;
    console.log("CLS:", entry.value.toFixed(4), entry.sources?.map(s =>
      s.node?.nodeName + "#" + s.node?.id + "." + s.node?.className
    ));
  }
}).observe({ type: "layout-shift", buffered: true });
```

This logs each layout shift with the element that moved — useful for quick identification without a full trace.

### Real Example: Diagnosing Raichu CLS

From an actual trace on espacosmart:
1. Trace showed Layout Shift score **0.59** at 1.2s mark
2. Affected element: `DIV#ra-verified-seal` in the Footer
3. Just before the shift: Network showed `raichu-beta/ra-verified/bundle.js` loading
4. The script injected CSS that resized the seal container from 0 to ~60px
5. **Fix**: Converted inline `<script>` to deferred React component with `minHeight: 60` container

## 9. `suppressHydrationWarning` for Dynamic Content

### Problem

Components that render dynamic content (counters, totals, timestamps, state-dependent lists) will always differ between server and client. React throws a hydration mismatch error for every element in the subtree.

### Fix — Target `suppressHydrationWarning` at the right level

Add `suppressHydrationWarning` to the **specific element** whose content changes, not the whole tree:

```tsx
// BAD — suppresses warnings for the entire component
<div suppressHydrationWarning>
  <header>...</header>
  <ul>
    {items.map(item => <li key={item.id}>{item.label}</li>)}
  </ul>
</div>

// GOOD — only on the element that actually differs
<ul suppressHydrationWarning>
  {items.map((item, i) => (
    <li key={item.id} suppressHydrationWarning>
      {item.label}
    </li>
  ))}
</ul>
```

### Common Cases

| Component | What changes | Where to add |
|-----------|-------------|--------------|
| Cart icon badge | item count | `<span>` showing count |
| User greeting | username from cookie | `<span>` with name |
| Wishlist button | favorite state | `<button>` or wrapper `<li>` |
| `UserInteractions` | wishlist/cart state per product | `<ul>` + `<li>` |

---

## 10. Missing `key` Props in Lists

### Problem

React warns `Each child in a list should have a unique "key" prop` when mapping arrays to JSX without a stable key. This causes:
- Console warnings during development
- Unexpected DOM reuse leading to visual glitches

### Fix — Always add `key` to mapped elements

```tsx
// BAD
{products.map(product => <ProductCard {...product} />)}

// GOOD — prefer stable IDs over index
{products.map(product => (
  <ProductCard key={product.productID} {...product} />
))}

// When stable ID unavailable — index is acceptable for static lists
{items.map((item, index) => (
  <li key={index}>{item.label}</li>
))}
```

### `Encountered two children with the same key`

Happens when the key source has duplicates (e.g., two products with `inProductGroupWithID` pointing to the same group). Use a combination:

```tsx
key={`${product.productID ?? ""}-${index}`}
```

### Common Affected Components in Deco Storefronts

| Component | Fix |
|-----------|-----|
| `BannerCarousel` dots/images | `key={index}` on each dot/image |
| `ProductShelf` product cards | `key={product.productID ?? index}` |
| `ImageGallery` images | `key={index}` |
| `SuccessFulHouse` items | `key={index}` |
| `InfoEnvironment` items | `key={item.id ?? index}` |
| `Slide01/02` big banners | `key={index}` |

---

## 11. Invalid HTML Nesting (`<a>` inside `<a>`)

### Problem

Nesting an `<a>` tag inside another `<a>` is invalid HTML. React and browsers both warn, and behavior is unpredictable (inner link may be ignored or outer link may break):

```
Warning: validateDOMNesting: <a> cannot appear as a descendant of <a>.
```

### Common Pattern

A "See more" link component is used inside a card that is itself a link:

```tsx
// BAD — SeeMoreLink renders <a>, but it's inside a <Link> (which renders <a>)
<Link to={product.url}>
  <img ... />
  <SeeMoreLink href={product.url} /> {/* renders <a> — invalid! */}
</Link>
```

### Fix — `insideLink` prop to switch to `<span>`

Add an `insideLink` prop to the child component to render a non-anchor element when it's already inside a link:

```tsx
// SeeMoreLink.tsx
interface Props {
  href: string;
  label?: string;
  insideLink?: boolean;
}

export function SeeMoreLink({ href, label = "Ver mais", insideLink }: Props) {
  if (insideLink) {
    // Already inside an <a> — use span to avoid invalid nesting
    return <span className="see-more-link">{label}</span>;
  }
  return (
    <a href={href} className="see-more-link">
      {label}
    </a>
  );
}

// Usage inside a card link:
<Link to={product.url}>
  <img ... />
  <SeeMoreLink href={product.url} insideLink /> {/* safe */}
</Link>
```

### Discovery Command

```bash
rg '<a[^>]*>.*<a' src/ --glob '*.{tsx,ts}' -l
rg 'SeeMoreLink|VerMais' src/ --glob '*.{tsx,ts}'
```

---

## 12. Diagnostic Checklist

When investigating hydration/flash issues on a Deco TanStack storefront:

1. **Record a Performance trace** (see section 8) — look for Layout Shift diamonds and white screenshot frames
2. **Open DevTools Console** — look for hydration mismatch errors (they tell you exactly which element differs)
3. **Check `__DECO_STATE`** — compare server vs client values for `site.name`; if different, fix env var injection
4. **Use the CLS console observer** (code above) — quickly identifies which elements shift without a full trace
5. **Disable browser extensions** — some extensions inject DOM that causes hydration mismatches
6. **Check for inline `<script>` tags in JSX** — these often load external CSS/JS that causes shifts; convert to deferred React components
7. **Verify sync registry** — ensure all above-the-fold sections are in `registerSectionsSync`
8. **Test with F5 (hard reload)** — SPA navigation may hide issues that appear on cold load
9. **Check scroll behavior** — navigate from shelf to PDP; verify page scrolls to top
10. **Compare SSR HTML vs client render** — view source (`Ctrl+U`) and compare with inspected DOM to find hydration diffs

---

## 13. `useDevice()` Hydration Mismatch in Eager Sections

### Root Cause

`@decocms/start` shell-renders sections in a **separate React root** that does NOT include providers from `__root.tsx`. This means `useDevice()` — which reads from `Device.Provider` — falls back to the context default (`isMobile: true`) on the server, while the client goes through `__root.tsx` and gets whatever value the Provider has.

Result: server renders mobile layout, client renders desktop layout → structural hydration mismatch.

This affects ONLY **eager sections** (sections in `alwaysEager` or not wrapped in CMS `Lazy.tsx`). Deferred sections render a skeleton server-side, and the real component loads client-side AFTER hydration — no mismatch.

### Which sections are affected

Check `alwaysEager` in `setup.ts`:
```typescript
setAsyncRenderingConfig({
  alwaysEager: [
    "site/sections/Header/Header.tsx",
    "site/sections/Header/NewHeader.tsx",
    "site/sections/Footer/Footer.tsx",
    "site/sections/Theme/Theme.tsx",
    "site/sections/Images/Carousel.tsx",
    "site/sections/Tipbar.tsx",
  ],
});
```

Any of these that call `useDevice()` and render different HTML structure based on `isMobile` will have a hydration error.

`LoadingFallback` components are also server-rendered (they're the skeleton while deferred section loads). LoadingFallbacks that use `useDevice()` to change the count or structure of elements will cause hydration mismatches on the skeleton itself.

### Fix Pattern A: Use `device` prop from loader (structural branches)

For sections that already receive `device` from their loader (`ctx.device`), use the prop instead of the hook:

```typescript
// Before — useDevice() reads from context, missing during shell render
function Header({ device, ...props }: Props) {
  const { isMobile } = useDevice(); // ← wrong: context not available in shell render
  if (isMobile) return <MobileLayout />;
  return <DesktopLayout />;
}

// After — device prop comes from loaderData, consistent on server + client
function Header({ device, ...props }: Props) {
  const isMobile = device === "mobile" || device === "tablet"; // ← correct
  if (isMobile) return <MobileLayout />;
  return <DesktopLayout />;
}
```

The `device` prop comes from the section loader:
```typescript
export async function loader(props: Props, req: Request, ctx?: AppContext) {
  return {
    ...props,
    device: ctx?.device as "mobile" | "desktop" | "tablet",
  };
}
```

`ctx.device` is detected from the request `User-Agent` header server-side. TanStack Start serializes loaderData and sends it to the client, so both server and client always use the same value. No mismatch.

> **The 3rd-arg `ctx` is real (#305).** The framework passes a compat `ctx` (device, `invoke`, per-app state, `response.headers`) as the loader's 3rd argument — see vtex-commerce.md §32. `ctx.device` here is genuinely populated. Keep app-state reads optional-chained (`ctx?.vtex?.…`) since an unconfigured app is `undefined`.

Also fix the section's `LoadingFallback` to use `props.device` instead of `useDevice()`:
```tsx
// Before
export const LoadingFallback = (props: LoadingFallbackProps & Props) => {
  const device = useDevice();
  const deviceProp = device.isMobile ? "mobile" : "desktop";
  return <Header {...props} device={deviceProp} />;
};

// After
export const LoadingFallback = (props: LoadingFallbackProps & Props) => {
  return <Header {...props} device={props.device ?? "desktop"} />;
};
```

### Fix Pattern B: Remove redundant JS conditionals (show/hide with CSS)

When a section renders show/hide elements based on `isMobile` but the containing elements ALREADY have responsive CSS classes (`hidden lg:block`, `hidden lg:flex`, `lg:hidden`), the JS conditional is redundant and causes the mismatch. Simply remove it:

```tsx
// Before — JS conditional + CSS class (redundant, causes mismatch)
{!isMobile && (
  <div className="hidden lg:flex">...</div>
)}

// After — CSS alone handles responsive behavior
<div className="hidden lg:flex">...</div>
```

This is the correct fix for Footer and similar layout sections where mobile/desktop differences are already handled by Tailwind responsive prefixes.

### Fix Pattern C: CSS-only responsive sizing (LoadingFallback skeletons)

For `LoadingFallback` components that use `useDevice()` to vary sizes or counts, replace JS with responsive Tailwind classes:

```tsx
// Before — causes hydration mismatch on skeleton
function LoadingCard() {
  const device = useDevice();
  return (
    <div className={`max-w-[${device.isMobile ? "160px" : "320px"}]`}>
      <div className={`h-${device.isMobile ? "40" : "60"}`} />
    </div>
  );
}

// After — CSS handles responsive sizing, no JS needed
function LoadingCard({ className }: { className?: string }) {
  return (
    <div className={`max-w-[160px] sm:max-w-[320px] ${className ?? ""}`}>
      <div className="h-40 sm:h-60" />
    </div>
  );
}

// For count variations in LoadingFallback:
// Before (renders 2 on mobile / 4 on desktop)
{Array(device.isMobile ? 2 : 4).fill(0).map((_, i) => <LoadingCard key={i} />)}

// After (always renders 4, CSS hides extras on mobile)
<LoadingCard />
<LoadingCard />
<LoadingCard className="hidden sm:flex" />
<LoadingCard className="hidden sm:flex" />
```

### Quick diagnosis

Search for `useDevice` in eager sections to find candidates:
```bash
rg "useDevice" src/sections/ src/components/header/ src/components/footer/ --glob "*.tsx"
```

Any result in a component that's always-eager and renders different element types/counts based on `isMobile` needs one of the fix patterns above.

---

## #55 `DeferredSectionWrapper`'s skeleton→resolved transition is a React element-type change — forces a full unmount/remount, non-deterministic CLS

**Severity**: BLOCKER — visible, non-deterministic layout shift (CLS measured 0 to 1.34 across identical loads of the same build) on any section using the documented `LoadingFallback = same component with reduced props` convention.

**Status**: fixed upstream, **[decocms/blocks#448](https://github.com/decocms/blocks/pull/448)** (open at time of writing) — kept here as a numbered gotcha because the framework patch alone does **not** fully close this class; see the caveat below.

`DecoPageRenderer.tsx`'s `DeferredSectionWrapper` returns the unresolved skeleton bare (`{skeleton}`), while every resolved branch wraps its content in `<SectionErrorBoundary>`. That's a React element-type change at the same fiber position across the skeleton→resolved transition, so React unmounts the skeleton subtree and mounts a fresh instance — even when the section's `LoadingFallback` renders the real component with reduced/empty props (a documented convention where the "skeleton" already has correct real markup/dimensions). Confirmed via a React mount/unmount trace correlated 1:1 with the Layout Instability API entry's timestamp, not just geometry — the shift is an unmount, not a resize (`currentRect: {0,0,0,0}`).

**Fix (framework, PR #448)**: wrap the unresolved skeleton branch in the same `SectionErrorBoundary` the resolved branches already use, so the wrapper shape stays identical across the transition and React can diff by type.

**Caveat — the framework fix alone is not sufficient**: when a *second*, independently-timed deferred section on the same page (e.g. a different Lazy-wrapped section racing its own `IntersectionObserver`) also remounts, it can still shift the page around an otherwise-stable section. With PR #448's patch installed and active, a farmrio page still regressed from CLS 0.0002 → 0.95 after a routine content refresh re-wrapped a *different* section in `Rendering/Lazy.tsx` (see the companion content-level fix below). Treat the framework patch and the content-level `Lazy.tsx`-unwrap workaround as complementary, not redundant, until proven otherwise.

**Discovery command**:
```bash
rg "DeferredSectionWrapper" node_modules/@decocms/tanstack/src
rg "Rendering/Lazy.tsx" .deco/blocks.gen.json  # count of sections still deferred
```

**Empirical evidence (farmrio-storefront, before/after CLS)**:
- Before fix: non-deterministic **0 to 1.34** across identical runs of the same build (Footer + `EtcSearchContainer` independently-timed `IntersectionObserver` race).
- Partial mitigation attempted first (unwrapping only the Footer's `Lazy.tsx`, without the framework fix) made it *worse*: **1.34** (two compounding shift events).
- Content-level per-page unwrap of every `Lazy.tsx` node on the 3 affected pages (see reference doc below): **0.0000–0.0009**, 10/10 clean.
- Framework fix (#448) verified against a real deployed Worker: 5/5 runs at **~0.0002** — until a content refresh re-wrapped a different section and CLS regressed to **0.95** even with the patch active; re-applying the content-level unwrap brought it back to **0.0045**.

See `migration/learnings/T64.md`, `T66.md`, `T70.md` for the full investigation chain.

### Reference: content-refresh-safe `Lazy.tsx` unwrap (companion to #55)

A full-tree `.deco/blocks` content mirror pull (the standard CMS content-refresh method) has no way to know a specific page was deliberately exempted from deferred rendering — it silently re-wraps sections in `Rendering/Lazy.tsx` on every pull, undoing a prior CLS fix. The durable fix is a `postgenerate` script, chained into `package.json`'s `generate` step, that recursively unwraps `Rendering/Lazy.tsx` nodes **only** within a maintained list of page paths (matched by the block's `path` field, not filename — on-disk filenames are inconsistently URL-encoded):

```typescript
const LAZY_RESOLVE_TYPE = "website/sections/Rendering/Lazy.tsx";
const TARGET_PATHS = new Set([
  "/farm-etc/alto-verao",
  "/sustentabilidade/cultura",
  "/produtos/acessorios/garrafas-e-copos",
]);

function unwrap(value: unknown, seen: Set<object>): [unknown, number] {
  if (!value || typeof value !== "object") return [value, 0];
  if (seen.has(value as object)) return [value, 0];
  seen.add(value as object);
  if (Array.isArray(value)) {
    let count = 0;
    const result = value.map((item) => {
      const [next, c] = unwrap(item, seen);
      count += c;
      return next;
    });
    return [result, count];
  }
  const obj = value as Record<string, unknown>;
  if (obj.__resolveType === LAZY_RESOLVE_TYPE && "section" in obj) {
    const [unwrapped, c] = unwrap(obj.section, seen);
    return [unwrapped, c + 1];
  }
  let count = 0;
  for (const key of Object.keys(obj)) {
    const [next, c] = unwrap(obj[key], seen);
    obj[key] = next;
    count += c;
  }
  return [obj, count];
}
```

Deliberately scoped to a specific page list, not sitewide — `Lazy.tsx` is the intentional deferred-loading mechanism on the rest of the site (~2300 other wrapped nodes on farmrio) and stripping it everywhere would be an unauthorized, large behavior change. Full source: `migration/scripts/fix-relazy-wrappers.ts` in farmrio-storefront (`migration/learnings/T70.md`).

**Proposed audit rule** (`packages/blocks-cli`): "any page previously content-patched to remove `Lazy.tsx` wrappers must have 0 such wrappers after `generate`" — encode the same check this script performs as a `deco-post-cleanup --strict` rule, keyed off a small manifest file instead of a hardcoded path list.

---

## #56 `LoadingFallback` exported as a wrapper *function* around the real component defeats React reconciliation, even after #55's framework fix

**Severity**: MEDIUM, but a hard blocker for #55's fix to actually work on a given section.

`export function LoadingFallback(props) { return <Real {...props} />; }` looks equivalent to an alias but isn't, at the React fiber-type level — the wrapper function and the real component are different types occupying the same position, so a resolved transition still forces a remount even with `SectionErrorBoundary` correctly wrapping both branches (#55).

**Fix**:
```tsx
// Before — different type than the resolved branch's <Real>, still remounts
export function LoadingFallback(props) {
  return <Real {...props} />;
}

// After — literal alias, same type across the transition
export const LoadingFallback = Real;
```

**Discovery command**:
```bash
rg "export function LoadingFallback\(" src/sections
```

**Empirical evidence (farmrio-storefront)**: required in combination with #55's framework patch for `Footer.tsx` to actually stop remounting; two further instances found by the same grep but not yet verified (`ETCImageContent.tsx`, `ETCBannerContentText.tsx`). See `migration/learnings/T64.md`.

**Proposed codemod** (`packages/blocks-cli`): detect the `export function LoadingFallback(props) { return <X {...props} />; }` shape and rewrite to `export const LoadingFallback = X;` wherever `X`'s prop type is a superset of the wrapper's own prop type.

---

## #57 A native `addEventListener` + `stopPropagation()` anywhere on the page silently kills every React `onClick` past that point in the load sequence

**Severity**: BLOCKER — every `onClick`/`onMouseEnter` etc. on any element the native listener's ancestor scope reaches stops firing, with zero console error.

React attaches one delegated listener at the document/root level; a native `click` listener attached directly to a target element fires *before* the event bubbles to React's delegated listener. Calling `e.stopPropagation()` inside that native listener prevents React's root listener from ever seeing the event — killing every React click handler on that element (or, if attached broadly via `querySelectorAll(...).forEach(el => el.addEventListener(...))`, on every matched element) from that point on. This is easy to introduce when porting an analytics/tracking snippet that attaches per-node native listeners to tagged elements (e.g. `[data-event]`).

**Fix**: use event delegation instead of per-node native listeners, and drop `stopPropagation()`:
```tsx
// Before — kills React's onClick on every [data-event] element once window "load" fires
window.addEventListener("load", () => {
  document.querySelectorAll("[data-event]").forEach((node) => {
    node.addEventListener("click", (e) => {
      e.stopPropagation();
      sendDomEvent(node);
    });
  });
});

// After — single delegated listener, no stopPropagation, closest-ancestor semantics preserved
document.body.addEventListener("click", (e) => {
  const el = (e.target as Element).closest("[data-event][data-event-trigger='click']");
  if (el) sendDomEvent(el);
});
```

**Discovery command**:
```bash
rg "addEventListener\(.?click.?" -g'*.tsx' -A3   # then check for stopPropagation in the same handler
rg "querySelectorAll\(.\[data-event\]" -g'*.tsx'
```

**Empirical evidence (farmrio-storefront)**: broke the header search trigger and the login trigger site-wide; 12-run headless Playwright repro, 0/12 toggled pre-fix, 12/12 post-fix, across 3 independent verification batches (36/36 total). See `migration/learnings/T33.md`, `T34.md`.

---

## #58 Controlled `checked={...}` with no matching `onChange` never responds to a real click — recurring across independent ports

**Severity**: MEDIUM, but user-facing and non-obvious: DOM devtools shows `checked` flipping on click (native browser behavior), while the actual UI never updates.

A native, uncontrolled `<input type="radio"/"checkbox">` ported to React as `checked={someExpression}` with no `onChange` becomes React-controlled — React reasserts `someExpression`'s value on every render, so a click never actually flips application state even though the DOM's own `checked` attribute may appear to toggle transiently. React additionally warns in the console ("you provided a `checked` prop to a form field without an `onChange` handler") — easy to miss if console warnings aren't being watched.

**Fix**: back the input with real state:
```tsx
// Before — frozen; checked is reasserted to the same value every render
<input type="radio" checked={isSingleVariant} />

// After
const [selected, setSelected] = useState(isSingleVariant ? defaultValue : null);
<input type="radio" checked={selected === value} onChange={() => setSelected(value)} />
```

**Discovery command**:
```bash
rg -l "checked=\{" src/components src/sections | xargs rg -L "onChange"
```

**Empirical evidence (farmrio-storefront)**: found and fixed independently 3 separate times across different files during one migration (`ButtonFastBuy.tsx` PLP/shelf quick-add, T46; `EtcOutOfStockForm.tsx`, T51; `Modal.tsx`'s checkbox reveal, flagged but unfixed, T54) — each grep pass that found one instance did not surface the others, since the exact expression and element differed each time.
