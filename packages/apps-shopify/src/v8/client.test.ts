// @vitest-environment node
/**
 * createShopifyClient (/next/upstream-clients#write-a-client): every request
 * goes through the instrumented fetch as provider "shopify", labeled with the
 * GraphQL operation name, and errors carry no bodies or tokens.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
  options: [] as unknown[],
  operations: [] as (string | undefined)[],
}));

vi.mock("@decocms/blocks/fetch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@decocms/blocks/fetch")>();
  return {
    createInstrumentedFetch: (options: Parameters<typeof real.createInstrumentedFetch>[0]) => {
      seen.options.push(options);
      const request = real.createInstrumentedFetch(options);
      return (input: string | URL | Request, init?: RequestInit & { operation?: string }) => {
        seen.operations.push(init?.operation);
        return request(input, init);
      };
    },
  };
});

import { createShopifyClient, ShopifyError } from "./client";

function upstream(body: unknown, status = 200) {
  return vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
}

const config = { storeName: "acme", storefrontAccessToken: "sf-token", apiVersion: "2026-07" };

beforeEach(() => {
  seen.options.length = 0;
  seen.operations.length = 0;
});

describe("createShopifyClient", () => {
  it("posts to the Storefront API through the instrumented fetch, with no retries or circuit breaker", async () => {
    const fetch = upstream({ data: { product: { id: "1" } } });
    const shopify = createShopifyClient(config, { fetch });

    const data = await shopify.storefront.query<{ product: { id: string } }>(
      "query ProductByHandle($handle: String!) { product(handle: $handle) { id } }",
      { handle: "linen-shirt" },
      { headers: { "Shopify-Storefront-Buyer-IP": "203.0.113.7" } },
    );

    expect(data).toEqual({ product: { id: "1" } });
    expect(seen.options).toEqual([{ provider: "shopify", fetch }]);
    expect(seen.operations).toEqual(["ProductByHandle"]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://acme.myshopify.com/api/2026-07/graphql.json");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "x-shopify-storefront-access-token": "sf-token",
      "Shopify-Storefront-Buyer-IP": "203.0.113.7",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "query ProductByHandle($handle: String!) { product(handle: $handle) { id } }",
      variables: { handle: "linen-shirt" },
    });
  });

  it("labels an unnamed document by its API surface", async () => {
    const fetch = upstream({ data: { shop: { name: "Acme" } } });
    const shopify = createShopifyClient(
      { ...config, adminAccessToken: "admin-token", apiVersion: "2025-07" },
      { fetch },
    );
    await shopify.storefront.query("{ shop { name } }");
    await shopify.admin.query("{ shop { name } }");

    expect(seen.operations).toEqual(["storefront.graphql", "admin.graphql"]);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://acme.myshopify.com/admin/api/2025-07/graphql.json",
    );
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      "x-shopify-access-token": "admin-token",
    });
  });

  it("refuses admin calls without an admin token, without sending anything", async () => {
    const fetch = upstream({ data: {} });
    const shopify = createShopifyClient(config, { fetch });
    await expect(shopify.admin.query("{ shop { name } }")).rejects.toThrow(/adminAccessToken/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports HTTP failures by operation and status, never the body or token", async () => {
    const fetch = upstream({ errors: "secret upstream detail sf-token" }, 401);
    const shopify = createShopifyClient(config, { fetch });
    const error = (await shopify.storefront
      .query("query Cart { cart { id } }")
      .catch((e: unknown) => e)) as ShopifyError;

    expect(error).toBeInstanceOf(ShopifyError);
    expect(error).toMatchObject({ operation: "Cart", status: 401, codes: [] });
    expect(error.message).toBe("shopify Cart failed with HTTP 401");
  });

  it("reports a non-JSON body as INVALID_JSON, never quoting the body", async () => {
    const fetch = vi.fn(async () => new Response("<html>sf-token</html>", { status: 200 }));
    const shopify = createShopifyClient(config, { fetch });
    const error = (await shopify.storefront
      .query("query Cart { cart { id } }")
      .catch((e: unknown) => e)) as ShopifyError;

    expect(error).toBeInstanceOf(ShopifyError);
    expect(error).toMatchObject({ operation: "Cart", status: 200, codes: ["INVALID_JSON"] });
    expect(error.message).not.toContain("sf-token");
    expect(error.message).not.toContain("<html");
  });

  it("reports GraphQL errors by their codes, not their messages", async () => {
    const fetch = upstream({
      errors: [
        { message: "Throttled for customer@example.com", extensions: { code: "THROTTLED" } },
        { message: "again", extensions: { code: "THROTTLED" } },
      ],
    });
    const shopify = createShopifyClient(config, { fetch });
    const error = (await shopify.storefront
      .query("query Cart { cart { id } }")
      .catch((e: unknown) => e)) as ShopifyError;

    expect(error).toMatchObject({ operation: "Cart", status: 200, codes: ["THROTTLED"] });
    expect(error.message).not.toContain("customer@example.com");
  });
});
