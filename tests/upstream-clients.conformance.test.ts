// @vitest-environment node
/**
 * Conformance: upstream-clients.mdx (Calling APIs) against the client
 * packages (`packages/apps-*`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAlgoliaClient } from "@decocms/apps-algolia";
import { createVtexClient } from "@decocms/apps-vtex";
import { describe, expect, it, vi } from "vitest";

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages");

/** The client module(s) of each platform package; the first builds the requests. */
const V8_CLIENTS: Record<string, string[]> = {
  "apps-vtex": ["src/vtexClient.ts"],
  "apps-shopify": ["src/client.ts", "src/graphqlOperationName.ts"],
  "apps-wake": ["src/wakeClient.ts"],
  "apps-magento": ["src/magentoClient.ts"],
  "apps-algolia": ["src/index.ts"],
  "apps-resend": ["src/emails.ts"],
  "apps-sfmc-personalization": ["src/index.ts"],
};

/** The source without comments, so doc examples (`process.env.X!` in a JSDoc) don't count. */
function code(pkg: string, file: string): string {
  return fs
    .readFileSync(path.join(PACKAGES, pkg, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("what a client is (upstream-clients.mdx)", () => {
  it("up-01: VTEX, Shopify, Wake, Magento, Algolia, Resend (and others) ship a client built on createInstrumentedFetch", () => {
    for (const [pkg, files] of Object.entries(V8_CLIENTS)) {
      expect(fs.existsSync(path.join(PACKAGES, pkg, "package.json"))).toBe(true);
      expect([pkg, code(pkg, files[0]!)]).toEqual([
        pkg,
        expect.stringMatching(
          /import \{[^}]*createInstrumentedFetch[^}]*\} from "@decocms\/blocks\/fetch"/,
        ),
      ]);
    }
  });

  it("up-02: clients take settings as arguments: no environment reads inside a client", () => {
    for (const [pkg, files] of Object.entries(V8_CLIENTS)) {
      for (const file of files) {
        expect([
          pkg,
          file,
          /process\.env|import\.meta\.env|Deno\.env/.test(code(pkg, file)),
        ]).toEqual([pkg, file, false]);
      }
    }
  });

  it("up-03: no React hooks, client components or shared-commerce converters in a client", () => {
    for (const [pkg, files] of Object.entries(V8_CLIENTS)) {
      for (const file of files) {
        const text = code(pkg, file);
        const found = [
          /["']use client["']/,
          /from ["']react["']/,
          /\buse(Cart|User|Wishlist)\b/,
          /@decocms\/apps-commerce/,
          /from ["']\.\/(loaders|actions|hooks)\//,
        ].filter((pattern) => pattern.test(text));
        expect([pkg, file, found]).toEqual([pkg, file, []]);
      }
    }
  });

  it("up-05: the Salesforce client is @decocms/apps-sfmc-personalization; @decocms/apps-salesforce is gone", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PACKAGES, "apps-sfmc-personalization/package.json"), "utf8"),
    );
    expect(pkg.name).toBe("@decocms/apps-sfmc-personalization");
    const names = fs
      .readdirSync(PACKAGES)
      .filter((dir) => fs.existsSync(path.join(PACKAGES, dir, "package.json")))
      .map(
        (dir) => JSON.parse(fs.readFileSync(path.join(PACKAGES, dir, "package.json"), "utf8")).name,
      );
    expect(names).not.toContain("@decocms/apps-salesforce");
  });

  it("up-07: clients don't cache upstream responses", () => {
    for (const [pkg, files] of Object.entries(V8_CLIENTS)) {
      for (const file of files) {
        expect([
          pkg,
          file,
          /createFetchCache|fetchWithCache|fetchCache|caches\.default|caches\.open|cachedLoader/.test(
            code(pkg, file),
          ),
        ]).toEqual([pkg, file, false]);
      }
    }
  });
});

describe("call a client (upstream-clients.mdx)", () => {
  it("up-06: createVtexClient({ account, appKey, appToken }) and vtex.search.products({ query, count })", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ products: [] }), { status: 200 }),
    );
    const vtex = createVtexClient({
      account: "mystore",
      appKey: "key",
      appToken: "token",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const products = await vtex.search.products({ query: "linen shirt", count: 12 });
    expect(products).toEqual({ products: [] });
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.host).toBe("mystore.vtexcommercestable.com.br");
    expect(url.pathname).toContain("product_search");
    expect(url.searchParams.get("query")).toBe("linen shirt");
    expect(url.searchParams.get("count")).toBe("12");
  });
});

describe("retries and failures (upstream-clients.mdx)", () => {
  it("up-08: the VTEX client retries by default", async () => {
    const statuses = [503, 200];
    const fetch = vi.fn(async () => new Response("{}", { status: statuses.shift() ?? 200 }));
    const vtex = createVtexClient({
      account: "mystore",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await vtex.search.products({ query: "shirt" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("up-08: the VTEX client's circuit breaker fails fast after repeated failures", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
    const vtex = createVtexClient({
      account: "mystore",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    for (let i = 0; i < 5; i++)
      await expect(vtex.search.products({ query: "shirt" })).rejects.toThrow();
    const before = fetch.mock.calls.length;
    await expect(vtex.search.products({ query: "shirt" })).rejects.toThrow();
    expect(fetch.mock.calls.length).toBe(before);
  }, 20_000);

  it("up-08: other clients leave retries off (one attempt on a 503)", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
    const algolia = createAlgoliaClient(
      { applicationId: "APP123", apiKey: "k" },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    await expect(
      algolia.search([{ indexName: "products", query: "shirt" }] as never),
    ).rejects.toThrow("algolia search failed with HTTP 503");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
