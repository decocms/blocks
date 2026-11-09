# CLS from third-party scripts and late content

Load when: CLS is above 0.1 (poor above 0.25); a review widget, trust seal, chat bubble or
banner script pushes content after load; the footer jumps.

Nothing here is specific to v8. Third-party scripts are the usual cause on storefronts,
followed by section fallbacks that are shorter than the section they stand in for.

## 1. Find the element that moved

Quickest: paste this in the console, then reload with the console open.

```js
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.hadRecentInput) continue;
    console.log("shift", entry.value.toFixed(4), entry.sources?.map((s) =>
      `${s.node?.nodeName}#${s.node?.id}.${s.node?.className}`));
  }
}).observe({ type: "layout-shift", buffered: true });
```

Each line is one shift, with its score and the nodes that moved. Then find what happened
just before it: a script, a stylesheet, a font, an image without dimensions. A Performance
trace shows that directly ([`trace-reading.md`](./trace-reading.md)). Lighthouse lists the
largest shifts under "Avoid large layout shifts".

Real case: a trace showed one shift of **0.59** at 1.2 s. The node was a trust-seal
container in the footer. Just before it, the seal's script loaded and injected CSS that
grew the container from 0 to ~60 px. Reserving the height and loading the script after
hydration removed the shift.

## 2. Usual offenders and fixes

| Source | What it does | Fix |
|---|---|---|
| Review or trust-seal widget | Injects markup and CSS after load | Reserve its height; load the script when idle |
| Chat or WhatsApp bubble | Adds a floating element | Fixed position only; load after hydration |
| Inline `<script>` that loads CSS | Restyles content already painted | Move it into a component that loads it after hydration |
| A section fallback | Shorter than the section that replaces it | Give the fallback the section's height |
| Images without size | Height unknown until the image loads | `width` and `height` on every image (`Image` from `@decocms/tanstack/react` takes them) |
| Web fonts | Text reflows when the font swaps | Preload the main font (`createDecoWorker({ preload: { fonts } })` sends `Link` preload headers) and use a fallback font with close metrics |

## 3. A deferred script component

Load a third-party script after hydration, when the browser is idle, into a container
with reserved height:

```tsx
import { useEffect, useRef } from "react";

export function DeferredScript({ id, src, dataset = {}, minHeight = 60 }: {
  id: string; src: string; dataset?: Record<string, string>; minHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || document.getElementById(id)) return;
    const load = () => {
      const script = document.createElement("script");
      script.id = id;
      script.async = true;
      script.src = src;
      for (const [k, v] of Object.entries(dataset)) script.dataset[k] = v;
      ref.current?.appendChild(script);
    };
    if ("requestIdleCallback" in window) {
      const handle = requestIdleCallback(load, { timeout: 3000 });
      return () => cancelIdleCallback(handle);
    }
    const timer = setTimeout(load, 2000);
    return () => clearTimeout(timer);
  }, [id, src]);
  return <div ref={ref} id={`${id}-container`} style={{ minHeight }} />;
}
```

- Measure the widget's final height on mobile and desktop and use it as `minHeight`.
- The `id` check stops a second copy after a client-side navigation.
- If the script must run before first paint (consent, some analytics), it cannot be
  deferred. Reserve the space instead.
- A site with a strict CSP must allow the script's origin.

## 4. Verify

- The console observer shows no shift above ~0.01 for the widget's container.
- Lighthouse mobile CLS on the page, before and after, on the same build of the rest.
- Check a page where the widget is below the fold: a shift there still counts if it
  happens in the viewport while the visitor scrolls.

For Core Web Vitals work beyond CLS, see `improving-web-vitals-tanstack` (decocms/skills).
