# @decocms/compat-v7

v7's pure helpers for sites moved from `@decocms/blocks` 7 to 8. Each one gives v7's output, byte for byte, so a migrated site imports it from here instead of keeping its own copy. Tests pin every helper against v7's own code (latest 7.x).

This is not a v7 runtime. There is no `ctx`, no invoke, no request scope and no cached loaders: v8 has none of them, and this package doesn't bring them back. It reads no environment variables.

Peer: `@decocms/blocks` (same version). The framework subpaths also use the site's binding: `/tanstack` takes `@decocms/tanstack` (and its `@tanstack/react-start` and `react`), `/nextjs` takes `@decocms/nextjs` (and its `next` and `react`). Those are optional peers; a site installs only its own.

## Types

```ts
import type { ImageWidget, RichText, SectionProps } from "@decocms/compat-v7/types";

export interface Props {
  image: ImageWidget;
  body: RichText;
}

export const loader = async (props: Props, req: Request) => ({ ...props, url: req.url });

export default function Banner(props: SectionProps<typeof loader>) {
  // ...
}
```

- `SectionProps<typeof loader>` is the loader's return value, awaited. v7 also unwrapped a `Promise`; for a synchronous loader, v7 gave the loader's own type, and here it gives the value.
- `Resolved<T>`, `LoadingFallbackProps` and `Flag` are v7's.
- The widget aliases (`ImageWidget`, `VideoWidget`, `HTMLWidget`, `RichText`, `TextArea`, `Color`, `TextWidget`, `ButtonWidget`, `Secret`) are strings. `deco schema` reads them by name, so a field gets the site editor's widget as it did on v7. `Secret` is v7's masked text box: a plain string saved in content, so keep real credentials in your deploy platform's secrets, read by the site's code and passed as params. `@decocms/compat-v7/types/widgets` has the aliases alone.

v7's `AppContext` and `FnContext` aren't here: they describe the `ctx` argument, which v8 doesn't pass.

## Device detection

```ts
import { detectDevice, isMobileUA } from "@decocms/compat-v7/device";

const device = detectDevice(request.headers.get("user-agent") ?? ""); // "mobile" | "tablet" | "desktop"
```

These are v7's user-agent patterns, checked in v7's order (tablet first). `isMobileUA` is true for phones and tablets.

## Inline scripts

```tsx
import { inlineScript, useScript } from "@decocms/compat-v7/script";

<script {...inlineScript(`document.body.dataset.ready = "true"`)} />
<script dangerouslySetInnerHTML={{ __html: useScript(onLoad, "banner-1") }} />
```

`useScript`, `useScriptAsDataURI` and `inlineScript` give v7's output. v7 warned in development about `fn.toString()`, because the server and the client build can serialize a function differently and break hydration. That warning is gone, because it read `NODE_ENV`, but the advice still holds: prefer `inlineScript` with a string.

## clx

```ts
import { clx } from "@decocms/compat-v7/clx";

clx("btn", isActive && "btn-active", undefined); // "btn btn-active"
```

It drops falsy values, joins the rest and collapses whitespace runs, as v7 did. Like v7, it doesn't trim.

## Matchers

```ts
import { type DeviceProps, device, type RandomProps, random } from "@decocms/compat-v7/matchers";

export const blocks = {
  "website/matchers/device.ts": (props: DeviceProps) => device(props, matcherContext()),
  "website/matchers/random.ts": (props: RandomProps) => random(props, matcherContext()),
};
```

`device`, `cookie`, `host`, `pathname`, `queryString`, `location`, `multi` and `random` give v7's results. A v8 block function gets only its inputs, so each matcher takes the request as its second argument: a `Request`, or `{ request, url, flags }`, where `url` is the page's URL when the request is a client-side navigation's server-function call, and `flags` is one array per request for the A/B decisions. `matcherContext()` stands for however the site reaches the request being served; the framework subpaths provide it. `always`, `never` and `date` are v8 built-ins, so they aren't here; v8's `date` names a campaign of the saved block `campaigns`, and the migration moves each v7 date window there.

- `random` is v7's sticky random (latest 7.x): a visitor keeps their group through the `deco_segment` cookie, and is drawn again once when the traffic share changes. The cookie is keyed on the test's **cohort, the saved matcher block's name**. A v8 block doesn't know its own name, so the block carries it in `cohort`; a random rule written inline uses `website/matchers/random.ts`, as v7 did. Keep the cohort when changing the traffic share: renaming it puts every visitor in a new test. The v7 → v8 migration doesn't register it: it reports each random matcher, to be moved into the saved block `experiments` (type `split-traffic`) under the same name, so visitors keep their groups, and the binding owns `deco_segment`. Don't run both on one site: two writers of the cookie undo each other's decisions.
- After the page resolved, `segmentSetCookie(request, flags)` gives the `Set-Cookie` to send, or `null` when the visitor's cookie already says the same. `decideRandom` returns a decision with that cookie. Don't cache a response that sets it for other visitors.
- `multi` gets its rules' results: v8 resolves them first. An inner `random` is sticky here; v7 drew it again on every request.
- `environment` throws: it read the process environment, which no v8 package does. Register your own matcher under its name.
- `location` reads the `cf-*` headers, then the Workers `request.cf`, then the `__cf_geo_*` cookies, as v7 did.

## Section loaders

```ts
import { compose, runSectionLoaders, withDevice, withSearchParam } from "@decocms/compat-v7/sections";

const loaders = {
  "site/sections/Product/ProductShelf.tsx": withDevice(),
  "site/sections/Header/Header.tsx": compose(withDevice(), withSearchParam()),
  "site/sections/Category/Banner.tsx": async (props, req) => ({ ...props, url: req.url }),
};

// After the page's sections resolved, once per page, globals included:
const { sections, degraded } = await runSectionLoaders(page.sections, { loaders, request, url: pageUrl });
```

`runSectionLoaders` runs v7's `(props, req)` section loaders the way v7 did after a page resolved, with v7's results:

- Each section runs its loader, then the sections in its props run theirs, wherever they are (latest 7.x). Sites whose v7 baseline is 7.77.12 or earlier pass `nested: "direct"`: those releases only ran the sections held directly in a prop or a list prop.
- A loader gets the props with `__pageUrl` and `__pagePath` added (values already in the props win), and a `GET` request for the page: `url` when the request is a client-side navigation's server-function call, else `request.url`, with the request's headers.
- A loader that throws leaves the section's saved props. The section is listed in `degraded` unless it's in `nonCritical` (v7's `registerNonCriticalSections`; put v7's layout sections there too, since v7 never marked them degraded). v7 sent `X-Deco-Degraded` when the list wasn't empty, so the page wasn't edge-cached.
- `runSectionLoader` does the same for one section (a deferred section).

v7's caches (layout sections, cacheable sections) and its registries aren't here: the loaders are an argument. v7's third argument, `ctx`, is gone. A loader that reads it throws an error that says what to use instead, and its section keeps the saved props.

`withDevice`, `withMobile`, `withSearchParam`, `compose` and `withSectionLoader` are v7's mixins, with v7's output. `withSectionLoader` keeps v7's catch: a section module's loader that throws returns the props, and the section isn't degraded.

v8 sections are `{ component, props }`. v7's resolver wrote nested sections as `{ Component, props }`; here a nested section has the same shape as a page section, and keeps any other keys it has.

## Commerce types and helpers

```ts
import type { Product } from "@decocms/compat-v7/commerce/types";
import { formatPrice } from "@decocms/compat-v7/commerce/sdk/formatPrice";
import { useOffer } from "@decocms/compat-v7/commerce/sdk/useOffer";
import { relative } from "@decocms/compat-v7/commerce/sdk/url";
import { mapProductToAnalyticsItem } from "@decocms/compat-v7/commerce/utils/productToAnalyticsItem";
```

v7's `@decocms/apps-commerce`, under `/commerce` with its own subpath layout: replace `@decocms/apps-commerce/` with `@decocms/compat-v7/commerce/` in an import and nothing else changes.

- `/commerce/types` (and `/commerce`): the schema.org commerce types (`Product`, `Offer`, `AggregateOffer`, `BreadcrumbList`, `ProductListingPage`, the analytics events, …), with the cart types re-exported. `/commerce/types/cart` has the cart types and section presets alone.
- `/commerce/sdk/*`: `formatPrice`/`formatPriceRange`, `relative`, `useOffer`/`bestInstallment`, `useVariantPossibilities`, and the analytics mappers (`analytics`).
- `/commerce/utils/*`: `canonicalFromBreadcrumblist`, `DEFAULT_IMAGE`, `parseRange`/`formatRange`, `mapProductToAnalyticsItem`, and `getStateFromZip` (default export of `stateByZip`).

Each file is v7's, formatting aside, and tests run v7's file next to it. None uses React (`useOffer` and `useVariantPossibilities` are plain functions despite the name). v7's app runtime (`app-types`, `manifest-utils`, `registry`, `resolve`) isn't here: v8 configures a client with arguments.

## TanStack Start (`@decocms/tanstack`)

```ts
// the block map
import { random, type RandomProps } from "@decocms/compat-v7/matchers";
import { matcherContext } from "@decocms/compat-v7/tanstack/server";

"website/matchers/random.ts": (props: RandomProps) => random(props, matcherContext()),

// the page's server function (it gets the page's href)
const page = await openPage(data.href);  // resolves the page, so the matchers run
commitSegmentCookie();                   // deco_segment, as v7's page route set it
return { ...page, device: requestDevice() };

// the page component
import { DeviceProvider } from "@decocms/compat-v7/tanstack";
<DeviceProvider value={page.device}>{sections}</DeviceProvider>

// src/worker-entry.ts: the segment of the site's own page cache
const segment = (request: Request) => ({ device: …, ...cohortSegment(request) });
```

- `matcherContext(pageUrl?)` gives every matcher the request being served (TanStack Start's `getRequest()`), the page's URL and one `flags` array per request. On a client-side navigation the request is the server-function call, so pass the page's URL there, as v7 matched the page being navigated to; without it, that call throws.
- `commitSegmentCookie()` sets `deco_segment` on the response with the decisions the matchers made, merged over the visitor's cookie: `deco_segment=<value>; Max-Age=31536000; Path=/; SameSite=Lax`, v7's bytes. Nothing when the cookie already says the same. Call it in the server function, after the page resolved. A site's page cache never stores a response that sets it, as v7's worker didn't: keep `deco_segment` out of the cookies its cache strips and stores (the worker-entry recipe in `@decocms/tanstack`'s README stores no response that sets a cookie other than its `SAFE_COOKIES`).
- `cohortSegment(request)` is v7's A/B split of the edge cache (`{ abf: <token> }` for a visitor in a test, `{}` otherwise), so each group keeps its own cached page and everyone else shares one.
- `requestDevice()` is v7's `detectDevice` on the request's user agent: the class the worker-entry recipe's cache key uses by default. Return it with the page so the browser hydrates with the same value. `useDevice()` reads the provider; without one it reads the browser's user agent (`"desktop"` on the server), as v7 did.

### The A/B split with the legacy origin

v7's `withABTesting` (the KV-driven split between the TanStack site and the site it replaces) is `abTestingRoutes`, a handler for `createDecoWorker`'s `routes`:

```ts
// src/worker-entry.ts
import { abTestingRoutes } from "@decocms/compat-v7/tanstack/worker";

const abTesting = abTestingRoutes({
  worker: () => worker,
  kvBinding: "SITES_KV",
  shouldBypassAB: (_request, url) => isCommercePath(url.pathname),
});

const worker = createDecoWorker({
  // …
  routes: async (request, env, ctx) => (await abTesting(request, env, ctx)) ?? siteRoutes(request),
});
export default worker;
```

- Same KV entry (`{ workerName, fallbackOrigin, abTest: { ratio } }` under the request's hostname), the same buckets (`?_deco_bucket=` override, then a `_deco_bucket=<bucket>:<ratio %>` cookie set under the current ratio, then the client IP's hash), the same cookie and `x-deco-bucket` header, circuit breaker, `shouldBypassAB`, `preHandler` and fallback proxy (hostname written back in `Set-Cookie`, `Location` and 2xx text bodies, streamed). Tests run v7's file next to it.
- v7 wrapped the whole worker. The handler runs where the worker runs its `routes`: after the CMS redirects, `/deco/_liveness` and the cache purge. For the "worker" bucket it calls the worker back (`worker`), so the page gets the bucket cookie and a worker error falls back to the legacy origin, as in v7; that inner call skips the handler and goes on to the site's other routes and the edge cache, which already lets `_deco_bucket` through on a cached page.
- A response from the legacy origin leaves through the worker like any `routes` response: `CDN-Cache-Control: no-store` when it sets none, the site's security headers when it sets none, and none of the worker's `preload` hints (they name the new site's assets; v7 sent none there). The "worker" bucket's page carries them once, from the inner call that rendered it.

## Next.js (`@decocms/nextjs`)

```ts
// proxy.ts: forward the visitor's URL (with the draft headers, if any)
import { pageUrlRequestHeaders } from "@decocms/compat-v7/nextjs/proxy";
const headers = pageUrlRequestHeaders(request, draftRequestHeaders(request, decision));
return applyDraft(NextResponse.next({ request: { headers } }), decision);

// the block map
import { matcherContext } from "@decocms/compat-v7/nextjs/server";
"website/matchers/random.ts": async (props: RandomProps) => random(props, await matcherContext()),

// the page (a server component)
import { SegmentCookie } from "@decocms/compat-v7/nextjs/server";
const sections = await resolvePage(...);  // the matchers run here
return <>{sections}<SegmentCookie nonce={nonce} /></>;

// app/layout.tsx
import { DeviceProvider } from "@decocms/compat-v7/nextjs";
<DeviceProvider value={await requestDevice()}>{children}</DeviceProvider>
```

- A server component sees the request's headers but not its URL, and the proxy may rewrite the path a page renders under. The proxy forwards the URL the visitor asked for on `x-deco-page-url` (replacing any copy from outside), and `matcherContext()` matches it; pass a URL to `matcherContext(url)` instead when the page knows it.
- The decisions are kept per request with React's `cache`.
- A server component can't set a cookie, and the proxy runs before the page decides. So `SegmentCookie` renders a one-line script that sets the same cookie v7's TanStack route sent (`deco_segment=<value>; Max-Age=31536000; Path=/; SameSite=Lax`), or nothing when the visitor's cookie already says the same. After a client-side navigation React renders the page itself and runs no script it renders, so an effect sets the same cookie then. Render it after the content resolved. A page that reads the request is dynamic, so Next never shares it between visitors; keep a CDN in front from caching it too. v7's Next.js binding never wrote this cookie: there, random drew again on every request.

The device context is the same module for both frameworks: one `DeviceContext`.

The package root exports the types, device, script and clx helpers. The matchers, the section runner, `/commerce/*` and the framework subpaths are only at their own subpaths.
