import { describe, expect, it, vi } from "vitest";
import { cmsScreenConfig, deferredSectionConfig } from "./cmsScreenConfig";
import type { RenderJsonClient } from "./renderJson";

const client = {
  fetchPage: vi.fn(async () => ({ name: "Home Page", path: "/", sections: [] })),
  fetchSection: vi.fn(async () => ({ component: "Shelf.tsx", props: {} })),
  pageUrl: (p: string) => p,
} as unknown as RenderJsonClient;

describe("cmsScreenConfig — query key", () => {
  it("keys by path", () => {
    expect(cmsScreenConfig({ client, path: "/products/x" }).queryKey).toEqual([
      "deco",
      "page",
      "/products/x",
    ]);
  });

  it("drops ignored params so variant switching does not refetch", () => {
    // Same default as the site's cmsRouteConfig: skuId is resolved client-side.
    expect(cmsScreenConfig({ client, path: "/products/x?skuId=9" }).queryKey).toEqual([
      "deco",
      "page",
      "/products/x",
    ]);
  });

  it("keeps params that do change the page", () => {
    expect(cmsScreenConfig({ client, path: "/s?q=hat" }).queryKey).toEqual([
      "deco",
      "page",
      "/s?q=hat",
    ]);
  });

  it("is order-insensitive, so the same page is one cache entry", () => {
    const a = cmsScreenConfig({ client, path: "/s?b=2&a=1" }).queryKey;
    const b = cmsScreenConfig({ client, path: "/s?a=1&b=2" }).queryKey;
    expect(a).toEqual(b);
  });

  it("honors a custom ignore list", () => {
    expect(
      cmsScreenConfig({ client, path: "/s?q=hat&utm_source=x", ignoreSearchParams: ["utm_source"] })
        .queryKey,
    ).toEqual(["deco", "page", "/s?q=hat"]);
  });

  it("defaults to the site root", () => {
    expect(cmsScreenConfig({ client }).queryKey).toEqual(["deco", "page", "/"]);
  });
});

describe("cmsScreenConfig — behavior", () => {
  it("fetches the ORIGINAL path, not the stripped key", () => {
    // Dropping skuId from the cache key must not drop it from the request —
    // the worker still needs it to pick the variant.
    const cfg = cmsScreenConfig({ client, path: "/products/x?skuId=9" });
    cfg.queryFn();
    expect(client.fetchPage).toHaveBeenCalledWith("/products/x?skuId=9");
  });

  it("carries staleTime/gcTime from the shared cache profiles", () => {
    const cfg = cmsScreenConfig({ client, path: "/" });
    expect(typeof cfg.staleTime).toBe("number");
    expect(typeof cfg.gcTime).toBe("number");
  });
});

describe("deferredSectionConfig", () => {
  it("keys by the opaque lazyUrl", () => {
    const cfg = deferredSectionConfig(client, "/?renderJson=&app=1&__section=5");
    expect(cfg.queryKey).toEqual(["deco", "section", "/?renderJson=&app=1&__section=5"]);
  });

  it("never goes stale on its own — the page it belongs to governs that", () => {
    expect(deferredSectionConfig(client, "/x").staleTime).toBe(Number.POSITIVE_INFINITY);
  });
});
