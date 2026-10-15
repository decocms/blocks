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

Everything is also exported from the package root.
