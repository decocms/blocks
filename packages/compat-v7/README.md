# @decocms/compat-v7

v7's pure helpers for sites moved from `@decocms/blocks` 7 to 8. Each one gives v7's output, byte for byte, so a migrated site imports it from here instead of keeping its own copy. Tests pin every helper against v7's own code (latest 7.x).

This is not a v7 runtime. There is no `ctx`, no invoke, no request scope and no cached loaders: v8 has none of them, and this package doesn't bring them back. It reads no environment variables.

Peer: `@decocms/blocks` (same version).

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
- The widget aliases (`ImageWidget`, `VideoWidget`, `HTMLWidget`, `RichText`, `TextArea`, `Color`, `TextWidget`, `ButtonWidget`, `Secret`) are strings. `deco schema` reads them by name, so a field gets the site editor's widget as it did on v7. `Secret` makes the field a secret block, as v8's `Secret` does. `@decocms/compat-v7/types/widgets` has the aliases alone.

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

`device`, `cookie`, `host`, `pathname`, `queryString`, `location`, `multi` and `random` give v7's results. A v8 block function gets only its inputs, so each matcher takes the request as its second argument: a `Request`, or `{ request, url, flags }`, where `url` is the page's URL when the request is a client-side navigation's server-function call, and `flags` is one array per request for the A/B decisions. `matcherContext()` stands for however the site reaches the request being served; the framework subpaths provide it. `always`, `never` and `date` are v8 built-ins, so they aren't here.

- `random` is v7's sticky random (latest 7.x): a visitor keeps their group through the `deco_segment` cookie, and is drawn again once when the traffic share changes. The cookie is keyed on the test's **cohort, the saved matcher block's name**. A v8 block doesn't know its own name, so the block carries it in `cohort`; a random rule written inline uses `website/matchers/random.ts`, as v7 did. Keep the cohort when changing the traffic share: renaming it puts every visitor in a new test.
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

Everything except the matchers and the section runner is also exported from the package root.
