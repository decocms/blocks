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

Everything except the matchers is also exported from the package root.
