/**
 * Coverage for the Magento observability wiring added so cache/upstream
 * telemetry flows automatically:
 *   - `magentoOperationRouter` names REST resources + GraphQL.
 *   - `setMagentoFetch` actually reroutes `magentoFetch`'s egress (the hook
 *     that lets `createMagentoFetch()`'s instrumentation take effect).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { magentoOperationRouter } from "../operationRouter";

describe("magentoOperationRouter", () => {
  it("names REST resources by their first V1 segment", () => {
    expect(magentoOperationRouter("https://x.com/rest/default/V1/products/42", "GET")).toBe(
      "rest.products",
    );
    expect(magentoOperationRouter("https://x.com/rest/V1/carts/mine", "POST")).toBe("rest.carts");
  });

  it("names GraphQL calls `graphql`", () => {
    expect(magentoOperationRouter("https://x.com/graphql", "POST")).toBe("graphql");
  });

  it("returns undefined when nothing matches (framework falls back)", () => {
    expect(magentoOperationRouter("https://x.com/media/logo.png", "GET")).toBeUndefined();
  });

  it("tolerates non-absolute URLs", () => {
    expect(magentoOperationRouter("/rest/default/V1/orders?x=1", "GET")).toBe("rest.orders");
  });
});

describe("setMagentoFetch routing", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes magentoFetch egress through the fetch set via setMagentoFetch", async () => {
    const { configureMagento, setMagentoFetch, magentoFetch } = await import("../../client");
    configureMagento({
      baseUrl: "https://loja.example.com/",
      apiKey: "k",
      storeId: 1,
      site: "example",
    });
    const custom = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const globalSpy = vi.spyOn(globalThis, "fetch");
    setMagentoFetch(custom);

    await magentoFetch("/rest/default/V1/products/1");

    expect(custom).toHaveBeenCalledOnce();
    expect(globalSpy).not.toHaveBeenCalled(); // did NOT hit the default fetch
  });
});
