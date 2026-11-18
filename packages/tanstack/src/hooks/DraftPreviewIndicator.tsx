/**
 * Preview-mode badge gate — the TanStack binding.
 *
 * Mounts the shared `DraftPreviewBadge` (`@decocms/blocks/preview`) only when
 * the request is rendering a draft. `DecoRootLayout` renders it automatically,
 * so sites get the badge on a package bump with no code change; it renders
 * nothing at all on ordinary (published) traffic.
 *
 * ## Isomorphic pointer, hydration-safe
 *
 * TanStack Start renders this component on BOTH server and client (no RSC
 * boundary). The pointer only exists server-side (the request bag), so:
 *
 *  - **Server:** read it from `RequestContext` and emit a tiny inline `<script>`
 *    that publishes it on `window.<GLOBAL>`. Inline scripts execute during HTML
 *    parse, before hydration.
 *  - **Client:** `RequestContext` resolves to a no-op stub in the browser
 *    bundle (the `browser` export condition), so the bag read returns
 *    undefined and we fall back to `window.<GLOBAL>` — which the just-executed
 *    inline script set to the server's value, so the hydration render computes
 *    the SAME pointer and the `<script>` node reconciles cleanly.
 *
 * Reading the bag first (then the global) — rather than branching on
 * `typeof window` — is also what makes this testable under jsdom, where
 * `window` always exists.
 *
 * The badge itself starts hidden and reveals via a client effect (fails
 * closed), so the visible chip never participates in the hydration diff.
 *
 * ## Loaded only while drafting
 *
 * `DecoRootLayout` mounts this on every page, so a static import put the badge
 * — and the deco mark it embeds as a base64 PNG, ~22 KB gzipped — in every
 * page's JS for every shopper, though it only ever renders for an editor
 * previewing a draft. It is a lazy chunk now: requested only when a pointer
 * exists, behind a `Suspense` with no fallback (the chip starts hidden anyway).
 */

import { getRequestNonce } from "@decocms/blocks/sdk/nonce";
import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { lazy, Suspense } from "react";
import { DRAFT_POINTER_BAG_KEY, DRAFT_POINTER_GLOBAL } from "../sdk/draftShared";

const DraftPreviewBadge = lazy(() =>
  import("@decocms/blocks/preview").then((m) => ({ default: m.DraftPreviewBadge })),
);

/**
 * The active draft pointer. Server: the request bag (set by `bindRequestDraft`).
 * Client: the bag is a stub → undefined → fall back to the published global.
 */
function activePointer(): string | null {
  const fromBag = RequestContext.getBag<string>(DRAFT_POINTER_BAG_KEY);
  if (fromBag) return fromBag;
  if (typeof window !== "undefined") {
    return (window as unknown as Record<string, string | undefined>)[DRAFT_POINTER_GLOBAL] ?? null;
  }
  return null;
}

export function DraftPreviewIndicator() {
  const pointer = activePointer();
  if (!pointer) return null;
  return (
    <>
      {/* Publishes a JSON-encoded pointer this server resolved (not user
          input) so the client's hydration render matches. See the module doc. */}
      <script
        nonce={getRequestNonce()}
        dangerouslySetInnerHTML={{
          __html: `window.${DRAFT_POINTER_GLOBAL}=${JSON.stringify(pointer)}`,
        }}
      />
      <Suspense fallback={null}>
        <DraftPreviewBadge pointer={pointer} />
      </Suspense>
    </>
  );
}
