import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestContext } from "../sdk/requestContext";
import { buildSectionLoaderContext } from "./sectionLoaderContext";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const TABLET_UA = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15";

function reqWithUA(ua: string, url = "https://store.example/path?q=shoes"): Request {
  return new Request(url, { headers: { "user-agent": ua } });
}

describe("buildSectionLoaderContext", () => {
  describe("device", () => {
    it("detects mobile / desktop / tablet from the request User-Agent", () => {
      expect(buildSectionLoaderContext(reqWithUA(MOBILE_UA)).device).toBe("mobile");
      expect(buildSectionLoaderContext(reqWithUA(DESKTOP_UA)).device).toBe("desktop");
      expect(buildSectionLoaderContext(reqWithUA(TABLET_UA)).device).toBe("tablet");
    });

    it("defaults to desktop when there is no User-Agent", () => {
      expect(buildSectionLoaderContext(new Request("https://store.example/")).device).toBe(
        "desktop",
      );
    });

    it("never throws for a minimal/mock request without headers", () => {
      const badReq = { url: "not a url" } as unknown as Request;
      expect(() => buildSectionLoaderContext(badReq)).not.toThrow();
      expect(buildSectionLoaderContext(badReq).device).toBe("desktop");
    });
  });

  describe("app state", () => {
    it("resolves ctx.<appName> to the app's registered state inside a request scope", async () => {
      const req = reqWithUA(DESKTOP_UA);
      await RequestContext.run(req, async () => {
        RequestContext.setBag("app:vtex:state", { config: { account: "acme" } });
        const ctx = buildSectionLoaderContext(req);
        expect((ctx as any).vtex).toEqual({ config: { account: "acme" } });
        expect(ctx.getAppState("vtex")).toEqual({ config: { account: "acme" } });
      });
    });

    it("returns undefined for an unconfigured app (no fake object)", async () => {
      const req = reqWithUA(DESKTOP_UA);
      await RequestContext.run(req, async () => {
        const ctx = buildSectionLoaderContext(req);
        expect((ctx as any).salesforce).toBeUndefined();
      });
    });

    it("returns undefined for app state outside a request scope", () => {
      const ctx = buildSectionLoaderContext(reqWithUA(DESKTOP_UA));
      expect((ctx as any).vtex).toBeUndefined();
    });
  });

  describe("response.headers", () => {
    it("writes through to RequestContext.responseHeaders inside a scope", async () => {
      const req = reqWithUA(DESKTOP_UA);
      await RequestContext.run(req, async () => {
        const ctx = buildSectionLoaderContext(req);
        ctx.response.headers.set("set-cookie", "a=1");
        expect(RequestContext.responseHeaders.get("set-cookie")).toBe("a=1");
      });
    });

    it("degrades to an inert Headers outside a scope (does not throw)", () => {
      const ctx = buildSectionLoaderContext(reqWithUA(DESKTOP_UA));
      expect(() => ctx.response.headers.set("x", "y")).not.toThrow();
    });
  });

  describe("invoke (server-side self-fetch)", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("POSTs to the request's absolute origin /deco/invoke/<key>", async () => {
      const ctx = buildSectionLoaderContext(reqWithUA(DESKTOP_UA, "https://store.example/pdp"));
      const result = await ctx.invoke.vtex.loaders.product.detailsPageGQL({ slug: "x" });

      expect(result).toEqual({ ok: true });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://store.example/deco/invoke/vtex/loaders/product/detailsPageGQL");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ slug: "x" });
    });

    it("injects the request AbortSignal when invoked inside a request scope", async () => {
      const req = reqWithUA(DESKTOP_UA, "https://store.example/pdp");
      await RequestContext.run(req, async () => {
        const ctx = buildSectionLoaderContext(req);
        await ctx.invoke.vtex.loaders.x({});
        const [, init] = fetchMock.mock.calls[0];
        expect(init.signal).toBeInstanceOf(AbortSignal);
      });
    });
  });
});
