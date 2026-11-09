# The document, Studio and security headers

## `src/routes/__root.tsx`

```tsx
import { DecoDocument } from "@decocms/tanstack/react";
import { createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "My Store" },
    ],
  }),
  component: () => <DecoDocument site="my-store" lang="pt-BR" />,
});
```

`DecoDocument` is the whole `<html>`: `<HeadContent />` in the head, the page in `<main>`,
TanStack's `<Scripts />` at the end of the body, and the Deco pieces below. Mount it as the root
route's `component`.

| Prop | Default | What it sets |
|---|---|---|
| `site` | (required) | The site's name in Deco; the "." shortcut opens the page under it in Studio. |
| `lang` | `"en"` | `<html lang>`. |
| `bodyClassName` | `"bg-base-200 text-base-content"` | `<body class>`. |
| `account` | `""` | The commerce account in `window.__RUNTIME__`, which analytics scripts read. |
| `readyDelay` | `500` | ms after hydration before `deco:ready` fires. |
| `outlet` | `"main"` | The element around the page. `"div"` when the page renders its own `<main>`. |
| `editShortcut` | on | The "." shortcut that opens the page in Studio. `false` turns it off. |
| `nonce` | none | The CSP nonce for its inline scripts. |
| `studioOrigins` | see below | The Studio origins the page trusts. |
| `children` | none | Rendered after the page (toasts, drawers, analytics). |

**Set `lang`.** It defaults to `"en"`, so a Portuguese or Spanish store renders
`<html lang="en">` until you pass the right BCP 47 tag (`pt-BR`, `es-AR`). Accessibility checkers
and SEO audits flag the mismatch. Check it in the page source. (On Fresh this was `ctx.lang` in
`fresh.config.ts`; that file doesn't exist on v8.)

`<html>` always carries `data-theme="light"` (DaisyUI reads its colors from it).

What else it mounts:

- The `DECO.events` bus and a `data-event` observer that dispatches the events elements declare,
  on view or click. Analytics go through it.
- `deco:ready`: `window.__deco_ready = true` and a `deco:ready` event on `document`, `readyDelay` ms
  after hydration. Work that must follow hydration waits for it.
- `NavigationProgress` and `StableOutlet` ([`router-and-navigation.md`](./router-and-navigation.md)).
- An inline script that publishes the request's draft and CDN segment token to `window`.
- `StudioBridge`, `StudioChannel` and `DraftBadge` from `@decocms/blocks/preview` (below).

## The head

The root route's `head()` holds what every page shares; each page route's `head()` adds its own
title and meta from its loader data ([`routes-and-pages.md`](./routes-and-pages.md)). Both end up in
`<HeadContent />`. Don't write `<title>` or `<meta>` tags into the document by hand.

## Your own document

A layout `DecoDocument` can't express (a skip link before `<main>`, a different body structure)
keeps its own document, like any TanStack Start app, and renders `DecoPreview` once in its
`<body>`:

```tsx
import { DecoPreview } from "@decocms/tanstack/react";

<body>
  <a href="#content" className="sr-only focus:not-sr-only">Skip to content</a>
  <main id="content">{children}</main>
  <DecoPreview site="my-store" />
  <Scripts />
</body>
```

`DecoPreview` takes `site`, `editShortcut`, `nonce` and `studioOrigins`. It renders the draft
script, `StudioBridge`, `StudioChannel` and `DraftBadge`. `StudioBridge` alone leaves draft pages
without the badge. You then own `<HeadContent />`, `<Scripts />`, `lang`, the events bus and the
progress bar.

## Studio inside the page

- **`StudioBridge`**: in Studio's frame it talks to Studio. Outside it, "." opens the current page
  in Studio's editor: the page whose route returns `pathTemplate` (and optionally `pageId`) in its
  loader data, else Studio picks it from the URL.
- **`StudioChannel`**: on every page, production included, about 0.7 kB gzipped. When a trusted
  Studio origin frames the page, it loads Studio's editor modules from that origin. Otherwise it
  does nothing. The bridge runs no script Studio sends.
- **`DraftBadge`**: shown on a draft page outside Studio's frame. A draft link that can't be read
  anymore shows a notice and the release.

**Studio's origins** are, in order: the `studioOrigins` prop, else the `DECO_STUDIO_ORIGIN`
environment variable (comma-separated, read on the server; a local Studio such as
`http://localhost:3000`), else Studio's production and staging origins (`DEFAULT_STUDIO_ORIGINS`
from `@decocms/tanstack`). Each entry must be an exact `http(s)` origin; anything else is dropped.
The worker puts the same list into the CSP. If you set `studioOrigins` on `DecoDocument`, set the
same list on `createDecoWorker`; `DECO_STUDIO_ORIGIN` sets both.

Studio's editor finds sections by their wrapper: `<section id data-manifest-key={component}>`
around each top-level section. How to render sections: `deco-site-authoring`.

## Security headers

The worker adds these to every HTML response that doesn't set them already:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `X-XSS-Protection` | `1; mode=block` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` |
| `Content-Security-Policy` | The site's `csp.enforce`, with Studio's additions |

There is no `X-Frame-Options`: `frame-ancestors` replaces it and, unlike `SAMEORIGIN`, can allow
Studio. A response that sets one of these headers keeps its own value.

## CSP

```ts
createDecoWorker({
  serverEntry, cms,
  csp: {
    enforce: ["default-src 'self'", "img-src 'self' https: data:"],
    reportOnly: "script-src 'self' https://analytics.example",
    frameAncestors: ["https://editor.example.com"],
  },
});
```

`enforce` and `reportOnly` take a string (`"a; b"`) or a list of directives. What the worker adds:

- **`frame-ancestors`**, when the enforced policy has none: `STUDIO_FRAME_ANCESTORS` (`'self'`
  and Studio's hosts), Studio's origins, `frameAncestors`, and loopback (`http://localhost:*`,
  `http://127.0.0.1:*`) in `dev`. A `frame-ancestors` the site writes is kept as is: then Studio
  frames the site only if that list names it.
- **Studio's origins in `script-src`** (and `script-src-elem`), so the Studio channel can import
  Studio's modules. A policy that restricts scripts only through `default-src` gets a `script-src`
  with `default-src`'s sources plus Studio's. A directive that is `'none'` stays as is.
- `reportOnly` goes out as `Content-Security-Policy-Report-Only`, with Studio's origins in its
  `script-src` and no added `frame-ancestors`.

With no `csp` at all, the policy is just the `frame-ancestors` directive.

A policy the site sends some other way (a `routes` response, another proxy) goes through
`withStudioCsp(directives, options?)` from `@decocms/tanstack`, which makes the same additions and
returns the directive list.

**A nonce.** If the policy requires a nonce for scripts, pass the same nonce to
`DecoDocument` (`nonce`) and to `createDecoRouter` (`nonce`), so Deco's inline scripts and
TanStack's scripts carry it.
