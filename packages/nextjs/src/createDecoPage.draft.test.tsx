/**
 * Draft-preview wiring in `createDecoPage`.
 *
 * Separate from `createDecoPage.test.tsx` because this file has to mock
 * `next/headers`, and that mock would otherwise apply to the plain
 * (non-draft) cases too — which are worth keeping honest about never
 * touching a dynamic API at all.
 */

import { registerSections, setBlocks } from "@decocms/blocks/cms";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// The gate must stop us reaching cookies() at all when the feature is off.
const cookiesMock = vi.fn(async () => ({ get: () => undefined }));
vi.mock("next/headers", () => ({
  cookies: () => cookiesMock(),
  headers: async () => new Headers(),
}));

// `connection()` is Next's runtime opt-out from static rendering; outside a
// request scope it throws, so it is stubbed to a no-op here.
const connectionMock = vi.fn(async () => {});
vi.mock("next/server", () => ({ connection: () => connectionMock() }));

const { createDecoPage } = await import("./createDecoPage");

function Hero({ label }: { label?: string }) {
  return <h1>{`hero-${label ?? "none"}`}</h1>;
}

function seedPublishedHome() {
  registerSections({ "site/sections/DraftHero.tsx": async () => ({ default: Hero }) });
  setBlocks({
    "pages-home": {
      path: "/",
      sections: [{ __resolveType: "site/sections/DraftHero.tsx", label: "published" }],
    },
  });
}

afterEach(() => {
  cookiesMock.mockClear();
  connectionMock.mockClear();
  delete process.env.DECO_ALLOWED_PREVIEW_HOSTS;
  delete process.env.DECO_SANDBOX_ORIGIN_SUFFIXES;
});

describe("createDecoPage — draft preview gate", () => {
  it("never reads cookies() when the feature is off", async () => {
    // Load-bearing, not a micro-optimisation: cookies() is a dynamic API, so
    // calling it unconditionally would opt EVERY page of EVERY site out of
    // static/ISR rendering the moment this package is upgraded.
    seedPublishedHome();

    const { default: Page } = createDecoPage({ siteName: "test-site" });
    const html = renderToString(await Page({ params: Promise.resolve({ slug: [] }) }));

    expect(html).toContain("hero-published");
    expect(cookiesMock).not.toHaveBeenCalled();
    expect(connectionMock).not.toHaveBeenCalled();
  });

  it("stays off when the flag is set but no origin suffix is configured", async () => {
    // Both halves are required — a bare flag with nowhere to fetch from is
    // inert, mirroring Fast Deploy's opt-in.
    process.env.DECO_DRAFT_PREVIEW = "1";
    seedPublishedHome();

    const { default: Page } = createDecoPage({ siteName: "test-site" });
    const html = renderToString(await Page({ params: Promise.resolve({ slug: [] }) }));

    expect(html).toContain("hero-published");
    expect(cookiesMock).not.toHaveBeenCalled();
  });

  it("reads cookies() once the feature is fully configured", async () => {
    process.env.DECO_ALLOWED_PREVIEW_HOSTS = "preview.example";
    seedPublishedHome();

    const { default: Page } = createDecoPage({ siteName: "test-site" });
    const html = renderToString(await Page({ params: Promise.resolve({ slug: [] }) }));

    // No draft pointer on the request, so the page still renders published —
    // enabling the feature must not change what an ordinary visitor sees.
    expect(html).toContain("hero-published");
    expect(cookiesMock).toHaveBeenCalled();
    // Nothing was bound, so no need to force the page dynamic.
    expect(connectionMock).not.toHaveBeenCalled();
  });
});
