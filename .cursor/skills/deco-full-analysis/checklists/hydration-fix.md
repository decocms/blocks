# Hydration Fix Checklist

9 learnings from real Deco sites. Check these during analysis.

> Post-split note: no more Preact/`$fresh/runtime.ts`/`islands/` — sites are React 19
> on TanStack Start or Next.js. See `.agents/skills/deco-to-tanstack-migration/references/hydration-fixes.md`
> in this repo for a much deeper, already-current reference (flash-of-white, `useDevice()`
> mismatches in eager sections, scroll restoration, `suppressHydrationWarning`, etc.) — it's
> worth checking directly rather than just this summary checklist.

## SDK & Script Race Conditions

### 1. SDK Initialization Guard
**Check**: Do components assume SDK is ready?

```typescript
// Bad: Race condition
const { cart } = useCart(); // May be undefined

// Good: Wait for SDK
async function waitForSDK() {
  while (!window.__STOREFRONT_SDK__) {
    await new Promise(r => setTimeout(r, 50));
  }
  return window.__STOREFRONT_SDK__;
}

const sdk = await waitForSDK();
const cart = sdk.cart;
```

### 2. Script Dependency Synchronization
**Check**: Do components wait for external scripts?

```typescript
// Good: Wait for HTMX
function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (check()) return resolve();
    const start = Date.now();
    const interval = setInterval(() => {
      if (check()) { clearInterval(interval); resolve(); }
      if (Date.now() - start > timeout) { clearInterval(interval); reject(); }
    }, 50);
  });
}

await waitFor(() => window.htmx !== undefined);
```

### 3. Safe Browser API Access
**Check**: Are `window`/`document` accessed during SSR?

```typescript
// Bad: Crashes on SSR
const width = window.innerWidth;

// Good: Check for browser — $fresh/runtime.ts's IS_BROWSER doesn't exist anymore;
// use a plain typeof check (verified: this is the exact replacement the CLI's
// codemod applies — see .agents/skills/deco-to-tanstack-migration/references/codemod-commands.md)
const IS_BROWSER = typeof window !== "undefined";

const width = IS_BROWSER ? window.innerWidth : 1024;
```

Also watch for `useDevice()` used inside **eager** sections (Header, Footer, Theme,
or anything in `alwaysEager` in `setup.ts`) — `@decocms/start` shell-renders eager
sections in a React root without `__root.tsx`'s providers, so `useDevice()` falls
back to its context default server-side while the client gets the real value,
producing a structural mismatch. Prefer the `device` prop injected by the section's
own server loader (via the `withDevice()` mixin from `@decocms/runtime/cms`) over
calling `useDevice()` directly in eager sections. See item 13 in the
`hydration-fixes.md` reference above for the full pattern and fixes.

## Unique IDs

### 4. Deterministic useId
**Check**: Are there hydration mismatches with IDs?

```typescript
// Bad: Random IDs cause mismatch
const id = Math.random().toString(36);

// Good: Deterministic based on props
function useStableId(prefix: string, index: number) {
  return `${prefix}-${index}`;
}
```

Or use a custom deterministic ID generator if `useId()` causes issues.

## External Widgets

### 5. Onload Script Guard
**Check**: Are external widgets manipulated before load?

```typescript
// Bad: Widget may not exist
document.querySelector('.hubspot-form').style.display = 'block';

// Good: Wait for load
script.onload = () => {
  const widget = document.querySelector('.hubspot-form');
  if (widget) widget.style.display = 'block';
};
```

### 6. MutationObserver for Third-Party Widgets
**Check**: Do third-party widgets need conditional styling?

```typescript
// Good: Watch for widget insertion
const observer = new MutationObserver((mutations) => {
  const widget = document.querySelector('.review-widget');
  if (widget) {
    widget.classList.add('loaded');
    observer.disconnect();
  }
});

observer.observe(document.body, { childList: true, subtree: true });
```

## HTML Content

### 7. HTML Repair Utility
**Check**: Is `dangerouslySetInnerHTML` used with external content?

```typescript
// Bad: Broken HTML causes hydration errors
<div dangerouslySetInnerHTML={{ __html: product.description }} />

// Good: Sanitize and repair
import DOMPurify from "dompurify";

function repairHtml(html: string): string {
  // Close unclosed tags, fix nesting
  const doc = new DOMParser().parseFromString(html, "text/html");
  return DOMPurify.sanitize(doc.body.innerHTML);
}

<div dangerouslySetInnerHTML={{ __html: repairHtml(product.description) }} />
```

## Lazy Loading

### 8. Deferred Portal Rendering
**Check**: Are heavy drawers rendered on mount?

```typescript
// Good: Lazy render minicart/menu — React 19, not Preact
import { createPortal } from "react-dom";

function Minicart() {
  const [show, setShow] = useState(false);
  
  return (
    <>
      <button onClick={() => setShow(true)}>Cart</button>
      {show && createPortal(<MinicartContent />, document.body)}
    </>
  );
}
```

### 9. Interaction-based Lazy Hydration
**Check**: Are heavy navigation menus loaded eagerly?

```typescript
// Good: Load drawer content on first interaction
function Header() {
  const [menuLoaded, setMenuLoaded] = useState(false);
  
  return (
    <button 
      onMouseEnter={() => setMenuLoaded(true)}
      onClick={() => setMenuLoaded(true)}
    >
      Menu
    </button>
    {menuLoaded && <MegaMenu />}
  );
}
```

## Quick Audit Commands

```bash
# Find direct window/document access — no islands/ directory anymore, so scan
# all of src/ (interactive code isn't confined to a separate top-level folder)
grep -rn "window\." src/ | grep -v "typeof window"
grep -rn "document\." src/ | grep -v "typeof window"

# Find dangerouslySetInnerHTML usage
grep -rn "dangerouslySetInnerHTML" src/sections/ src/components/

# Find Math.random in components (ID generation)
grep -rn "Math.random" src/sections/ src/components/

# Find useDevice() calls, then cross-check against alwaysEager in setup.ts —
# useDevice() in an eager section is a likely hydration-mismatch source (see above)
grep -rn "useDevice" src/sections/
grep -n "alwaysEager" -A 10 src/setup.ts
```

## Common Hydration Issues

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| "Text content mismatch" | Date/time formatting | Use consistent timezone |
| "Expected server HTML" / structural mismatch | `useDevice()` in an eager section (Header/Footer/Theme/`alwaysEager`) | Use the `device` prop from `withDevice()` loader mixin, or CSS media queries instead of a JS branch |
| "Hydration failed" | Random IDs | Use deterministic IDs |
| White flash on F5 | `React.lazy`/`Suspense` for above-the-fold sections | Register the section with `registerSectionsSync` (see `hydration-fixes.md` §1) |
| Missing styles | CSS-in-JS during SSR | Use Tailwind or static CSS |
| `A tree hydrated but some attributes... didn't match` for `__DECO_STATE` | `process.env.*` read differently on server vs client | Add a Vite `define` entry (see `hydration-fixes.md` §2) |
