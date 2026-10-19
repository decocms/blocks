import { describe, expect, it } from "vitest";
import { RequestContext } from "./requestContext";

describe("RequestContext.fork", () => {
  it("answers the forked request and keeps a copy of the parent bag", () => {
    const visitor = new Request("https://shop.test/plp?gclid=X1");
    const clean = new Request("https://shop.test/plp");

    RequestContext.run(visitor, () => {
      RequestContext.setBag("app:vtex:state", { account: "shop" });

      RequestContext.fork(clean, () => {
        expect(RequestContext.request.url).toBe("https://shop.test/plp");
        expect(RequestContext.getBag("app:vtex:state")).toEqual({ account: "shop" });
        RequestContext.setBag("forked-only", true);
        RequestContext.responseHeaders.set("x-forked", "1");
      });

      expect(RequestContext.request.url).toBe("https://shop.test/plp?gclid=X1");
      expect(RequestContext.getBag("forked-only")).toBeUndefined();
      expect(RequestContext.responseHeaders.has("x-forked")).toBe(false);
    });
  });

  it("does not follow the parent's abort signal", () => {
    const controller = new AbortController();
    const visitor = new Request("https://shop.test/plp", { signal: controller.signal });

    RequestContext.run(visitor, () => {
      RequestContext.fork(new Request("https://shop.test/plp"), () => {
        const forkedSignal = RequestContext.signal;
        controller.abort();
        expect(forkedSignal.aborted).toBe(false);
      });
    });
  });

  it("works outside a request scope", () => {
    expect(
      RequestContext.fork(new Request("https://shop.test/"), () => RequestContext.request.url),
    ).toBe("https://shop.test/");
  });
});
