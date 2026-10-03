// @vitest-environment node
/**
 * The v8 Wake client (/next/upstream-clients): every request goes through the
 * instrumented fetch as provider "wake", named by its operation, and errors
 * never carry bodies or tokens.
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

import { GetProduct } from "../storefront";
import { createWakeClient, WAKE_STOREFRONT_ENDPOINT, WakeError } from "../wakeClient";

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

beforeEach(() => {
  instrumented.providers.length = 0;
  instrumented.operations.length = 0;
});

describe("createWakeClient", () => {
  it("runs a storefront operation through the instrumented fetch, labeled by its name", async () => {
    const fetch = upstream({ data: { product: { productId: 1 } } });
    const wake = createWakeClient({ storefrontToken: "tok" }, { fetch });

    const data = await wake.graphql<{ product: { productId: number } }>(
      GetProduct,
      { productId: 1 },
      { headers: { "x-forwarded-for": "203.0.113.7", "tcs-access-token": "spoofed" } },
    );

    expect(data).toEqual({ product: { productId: 1 } });
    expect(instrumented.providers).toEqual(["wake"]);
    expect(instrumented.operations).toEqual(["GetProduct"]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(WAKE_STOREFRONT_ENDPOINT);
    const headers = init?.headers as Record<string, string>;
    expect(headers["tcs-access-token"]).toBe("tok"); // per-call headers can't override it
    expect(headers["x-forwarded-for"]).toBe("203.0.113.7");
    const body = JSON.parse(String(init?.body));
    expect(body.variables).toEqual({ productId: 1 });
    expect(body.query).toContain("fragment"); // fragments are sent with the document
  });

  it("throws a WakeError without the body on HTTP and GraphQL failures", async () => {
    const failing = createWakeClient(
      { storefrontToken: "tok" },
      { fetch: upstream({ secret: "x" }, 502) },
    );
    const httpError = await failure(failing.graphql("query Shop { shop { name } }"));
    expect(httpError).toBeInstanceOf(WakeError);
    expect(httpError.message).toBe("wake Shop failed with HTTP 502");

    const erroring = createWakeClient(
      { storefrontToken: "tok" },
      { fetch: upstream({ errors: [{ message: "customer jane@example.com not found" }] }) },
    );
    const gqlError = await failure(erroring.graphql("query Shop { shop { name } }"));
    expect(gqlError.message).toBe("wake Shop returned 1 GraphQL error(s)");
    expect(gqlError.message).not.toContain("jane");
    expect(gqlError.message).not.toContain("tok");
  });

  it("reads the signed-in shopper from the checkout, or null when signed out", async () => {
    const fetch = upstream({ CustomerAccessToken: "cat", Email: "a@example.com" });
    const wake = createWakeClient({ storefrontToken: "tok", account: "acme" }, { fetch });
    expect(await wake.getLogin("fbits-login=abc")).toMatchObject({ CustomerAccessToken: "cat" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://acme.checkout.fbits.store/api/Login/Get");
    expect(new Headers(init?.headers).get("cookie")).toBe("fbits-login=abc");
    expect(instrumented.operations).toEqual(["getLogin"]);

    const signedOut = createWakeClient(
      { storefrontToken: "tok", checkoutUrl: "https://checkout.example.com" },
      { fetch: upstream({}, 401) },
    );
    expect(await signedOut.getLogin("")).toBeNull();
  });
});
