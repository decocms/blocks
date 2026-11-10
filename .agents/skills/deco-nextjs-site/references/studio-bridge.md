# The Studio bridge

Studio's site editor shows the site in an iframe. The bridge is what lets it
scroll to a section, reload the page after a save and load its own editor
code into the page. On Next it is one component in the root layout.

## Wiring

```tsx
// src/app/layout.tsx
import { StudioBridge } from "@decocms/nextjs";
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <StudioBridge site="my-store" />
      </body>
    </html>
  );
}
```

`StudioBridge` renders two inline scripts and uses no hooks, so a Server
Component renders it as is. It reads no request, so it does not stop the root
layout from being cached.

| Prop | Default | What it does |
|---|---|---|
| `site` | required | The site's name in Studio |
| `editShortcut` | `true` | "." (or Ctrl+Shift+E) on a page outside Studio opens it in Studio's editor; Ctrl or Cmd+"." in a new tab |
| `studioOrigins` | `DECO_STUDIO_ORIGIN`, else Studio's production and staging origins | The exact origins the Studio channel trusts |
| `nonce` | none | The CSP nonce for the inline scripts |
| `page` | none | The page on screen; a `StudioPage` on the page wins |

## What it does

- **The shortcut script** listens for the "." shortcut, only outside a frame.
  It answers no message: v8 only, v7's framed handler (scroll-to-section,
  rerender) is gone, so no script on the page compares the window with `top`
  or `parent`, and a test runner that rewrites "frame-busting" code (Cypress)
  serves the page as is.
- **The Studio channel** runs on every page, production included (about
  0.7 kB gzipped). Framed by a trusted origin, it posts `{ type: "deco:ready" }`
  and imports a module only when the answer `{ type: "deco:load", url }`
  comes from exactly one trusted origin and names a URL on that origin. Not
  framed, or framed by anyone else, it does nothing. It never evaluates a
  script Studio sends. Message types are in `@decocms/blocks/protocol`.

## Which page "." opens

The root layout does not re-render on navigation, so it cannot know which
page is on screen. Each CMS page renders a marker next to its sections:

```tsx
import { StudioPage } from "@decocms/nextjs";

<StudioPage pathTemplate={page.path} />
```

`pathTemplate` is the page block's `path` as `matchRoute` matched it
(`/:slug/p`, not `/summer-shirt/p`). An optional `id` names the page block.
Without the marker, Studio picks the page from the URL.

## Content Security Policy

A site with a CSP must allow Studio's origins in `script-src` (the channel
imports Studio's modules) and in `frame-ancestors` (Studio frames the site).
`withStudioCsp(directives, options?)` from `@decocms/nextjs` adds them:

```ts
// next.config.ts
import { withStudioCsp } from "@decocms/nextjs";
import { withDeco } from "@decocms/nextjs/config";

const csp = withStudioCsp("script-src 'self' 'unsafe-inline'; object-src 'none'").join("; ");

export default withDeco({
  headers: async () => [
    { source: "/:path*", headers: [{ key: "Content-Security-Policy", value: csp }] },
  ],
});
```

- It adds the origins to `script-src` and `script-src-elem`. A policy that
  restricts scripts only through `default-src` gets a `script-src` with
  `default-src`'s sources plus Studio's.
- It adds `frame-ancestors` with Studio's only when the policy has none. A
  site's own `frame-ancestors` is kept as is: add Studio's yourself.
- Options: `studioOrigins`, `frameAncestors` (other editors allowed to frame
  the site), `dev: true` (loopback may frame the site),
  `addFrameAncestors: false`.
- Pass the same `nonce` to `StudioBridge` when the policy uses nonces.

A site that builds its headers in the proxy can set the same value there.

## A local or staging Studio

Set `DECO_STUDIO_ORIGIN` to a comma-separated list of exact origins (for
example `http://localhost:3000`). It replaces the default list for the
channel and for `withStudioCsp`. Each entry must be an exact http(s) origin;
anything else (a path, a wildcard) is dropped. An empty `studioOrigins={[]}`
turns the channel off.

`withDeco` adds Studio's hosts to `allowedDevOrigins`, so `next dev` serves
its dev assets when Studio frames a local site.

## Names for the site's own code

`@decocms/nextjs` exports what the proxy, the pages and `withDeco` use, for a
route that sets its own headers: `DRAFT_PARAM` (`__draft`), `DRAFT_COOKIE`
(`__deco_draft`), `VERSION_HEADER` (`x-deco-version`), `VISITOR_HEADER`
(`x-deco-visitor`), `ASSIGNMENTS_HEADER` (`x-deco-assignments`),
`draftResponseHeaders(...)`, `STUDIO_ORIGIN`, `STUDIO_ORIGINS`,
`STUDIO_FRAME_ANCESTORS`, `DEFAULT_STUDIO_ORIGINS`, `isStudioOrigin(origin)`,
`studioOrigins(option?)` and `withStudioCsp(...)`.

## When Studio can't drive the page

1. Is `StudioBridge` in the root layout's `<body>`, on every route?
2. Does the CSP allow Studio in `script-src` and `frame-ancestors`? Look for
   CSP errors in the framed page's console.
3. Does an `X-Frame-Options` header block framing? Remove it in favor of
   `frame-ancestors`.
4. Is Studio on a non-default origin? Set `DECO_STUDIO_ORIGIN` on the server.
5. Does "." open the wrong page? Render `StudioPage` with the matched
   `path` template.

Connecting a local site to Studio and the `deco` CLI side: load
`deco-site-workflow`.
