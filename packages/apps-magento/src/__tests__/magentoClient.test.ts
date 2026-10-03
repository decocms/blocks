// @vitest-environment node
/**
 * The v8 Magento client (/next/upstream-clients): every request goes through
 * the instrumented fetch as provider "magento", named by its operation; the
 * store's credentials only go to the store; errors never carry bodies.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const instrumented = vi.hoisted(() => ({
  providers: [] as string[],
  operations: [] as (string | undefined)[],
}));

vi.mock("@decocms/blocks/fetch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@decocms/blocks/fetch")>();
  return {
    createInstrumentedFetch: (options: Parameters<typeof real.createInstrumentedFetch>[0]) => {
      instrumented.providers.push(options.provider);
      const request = real.createInstrumentedFetch(options);
      return (input: string | URL | Request, init?: RequestInit & { operation?: string }) => {
        instrumented.operations.push(init?.operation);
        return request(input, init);
      };
    },
  };
});

import { createMagentoClient, MagentoError } from "../magentoClient";

/** The error a call rejects with (fails the test if it resolves). */
const failure = (call: Promise<unknown>): Promise<Error> =>
  call.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: Error) => error,
  );

function upstream(body: unknown, status = 200) {
  return vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
}

const config = { baseUrl: "https://store.example.com/", apiKey: "key", originHeader: "origin" };

beforeEach(() => {
  instrumented.providers.length = 0;
  instrumented.operations.length = 0;
});

describe("createMagentoClient", () => {
  it("calls REST with the store credentials, labeled by operation", async () => {
    const fetch = upstream({ id: 7 });
    const magento = createMagentoClient(config, { fetch });

    expect(
      await magento.rest<{ id: number }>("/rest/default/V1/carts/7", { operation: "getCart" }),
    ).toEqual({ id: 7 });
    expect(instrumented.providers).toEqual(["magento"]);
    expect(instrumented.operations).toEqual(["getCart"]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://store.example.com/rest/default/V1/carts/7");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer key");
    expect(headers.get("x-origin-header")).toBe("origin");
  });

  it("omits the token when a call opts out", async () => {
    const fetch = upstream({});
    const magento = createMagentoClient(config, { fetch });
    await magento.request("/customer/section/load", {
      operation: "loadSections",
      authenticated: false,
    });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBeNull();
  });

  it("refuses URLs on another origin, so the token never leaves the store", () => {
    const magento = createMagentoClient(config, { fetch: upstream({}) });
    expect(() => magento.request("https://evil.example/steal", { operation: "x" })).toThrow(
      /only paths on the configured store/,
    );
    expect(() => magento.request("//evil.example/steal", { operation: "x" })).toThrow();
  });

  it("sends GraphQL with its operationName, which is the label", async () => {
    const fetch = upstream({ data: { productStockAlert: { status: true } } });
    const magento = createMagentoClient(config, { fetch });
    const data = await magento.graphql<{ productStockAlert: { status: boolean } }>(
      "mutation ProductStockAlert($sku: String!) { productStockAlert(sku: $sku) { status } }",
      { sku: "A1" },
      { operationName: "ProductStockAlert", headers: { Store: "default" } },
    );
    expect(data.productStockAlert.status).toBe(true);
    expect(instrumented.operations).toEqual(["ProductStockAlert"]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://store.example.com/graphql");
    expect(new Headers(init?.headers).get("store")).toBe("default");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      operationName: "ProductStockAlert",
      variables: { sku: "A1" },
    });
  });

  it("throws a MagentoError without the body", async () => {
    const magento = createMagentoClient(config, {
      fetch: upstream({ message: "token key invalid" }, 401),
    });
    const error = await failure(magento.rest("/rest/V1/carts/mine", { operation: "getCart" }));
    expect(error).toBeInstanceOf(MagentoError);
    expect(error.message).toBe("magento getCart failed with HTTP 401");

    const gql = createMagentoClient(config, {
      fetch: upstream({ errors: [{ message: "x@example.com" }] }),
    });
    const gqlError = await failure(gql.graphql("query Q { a }", undefined, { operationName: "Q" }));
    expect(gqlError.message).toBe("magento Q returned 1 GraphQL error(s)");
  });
});
