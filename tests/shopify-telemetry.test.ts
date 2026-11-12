// @vitest-environment node
/** Real Shopify HTTP responses through the client and a local OTLP collector. */
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { createShopifyClient, ShopifyError } from "@decocms/apps-shopify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetForTests } from "../packages/blocks/src/v8/cms";
import {
  resolveDestination,
  setCurrentTelemetry,
  TelemetryPipeline,
} from "../packages/blocks/src/v8/telemetry";

interface Log {
  severityText: string;
  body: { stringValue: string };
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
}
interface Batch {
  resourceLogs: { scopeLogs: { logRecords: Log[] }[] }[];
}

const privateValue = "private-customer@example.com";
const config = {
  storeName: "private-store",
  storefrontAccessToken: "private-storefront-token",
  adminAccessToken: "private-admin-token",
  apiVersion: "2026-07",
};

async function fixture() {
  const state = {
    status: 200,
    body: JSON.stringify({ data: { shop: { name: "Acme" } } }),
    requests: [] as { path: string; method: string; body: unknown }[],
    batches: [] as Batch[],
    failures: [] as unknown[],
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (request.url === "/v1/logs") {
        const json = request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes;
        state.batches.push(JSON.parse(json.toString()) as Batch);
        response.end("{}");
      } else {
        state.requests.push({
          path: request.url ?? "",
          method: request.method ?? "",
          body: JSON.parse(bytes.toString()),
        });
        response.writeHead(state.status, { "content-type": "application/json" });
        response.end(state.body);
      }
    })().catch((error: unknown) => {
      state.failures.push(error);
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const destination = resolveDestination({ endpoint: origin }, "shopify-test");
  if (destination === null) throw new Error("Missing fixture destination");
  const pipeline = new TelemetryPipeline(destination);
  pipeline.apply({ errorSampleRate: 1, traceSampleRate: 0, metrics: false });
  setCurrentTelemetry(pipeline);
  const client = createShopifyClient(config, {
    fetch: (input, init) => globalThis.fetch(`${origin}${new URL(String(input)).pathname}`, init),
  });
  return Object.assign(state, {
    client,
    pipeline,
    logs: () =>
      state.batches.flatMap((batch) =>
        batch.resourceLogs.flatMap((resource) =>
          resource.scopeLogs.flatMap((scope) => scope.logRecords),
        ),
      ),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  });
}

function attributes(log: Log) {
  return Object.fromEntries(
    log.attributes.map(({ key, value }) => [key, value.stringValue ?? Number(value.intValue)]),
  );
}

describe("Shopify failure logs", () => {
  let server: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    resetForTests();
    server = await fixture();
  });
  afterEach(async () => {
    resetForTests();
    await server.close();
    expect(server.failures).toEqual([]);
  });

  it.each([
    "storefront",
    "admin",
  ] as const)("%s logs HTTP-200 internal errors even when the caller catches them", async (surface) => {
    server.body = JSON.stringify({
      data: { partial: privateValue },
      errors: [{ message: privateValue, extensions: { code: "INTERNAL_SERVER_ERROR" } }],
    });
    await expect(
      server.client[surface].query("query Product { product { id } }"),
    ).rejects.toMatchObject({ status: 200, codes: ["INTERNAL_SERVER_ERROR"] });
    await server.pipeline.flush();
    expect(server.logs()).toMatchObject([{ severityText: "ERROR" }]);
    expect(attributes(server.logs()[0]!)).toEqual({
      provider: "shopify",
      operation: "Product",
      "error.code": "INTERNAL_SERVER_ERROR",
      "http.response.status_code": 200,
    });
    expect(JSON.stringify(server.batches)).not.toContain(privateValue);
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    "THROTTLED",
    "ACCESS_DENIED",
    "SHOP_INACTIVE",
    "MAX_COST_EXCEEDED",
  ])("logs %s once as WARN without retrying a mutation", async (code) => {
    server.body = JSON.stringify({ errors: [{ extensions: { code } }, { extensions: { code } }] });
    const document = "mutation AddToCart($email: String!) { cartCreate { cart { id } } }";
    const variables = { email: privateValue };
    await expect(server.client.storefront.query(document, variables)).rejects.toMatchObject({
      codes: [code],
    });
    await server.pipeline.flush();
    expect(server.logs()).toMatchObject([{ severityText: "WARN" }]);
    expect(attributes(server.logs()[0]!)["error.code"]).toBe(code);
    expect(server.requests).toEqual([
      { path: "/api/2026-07/graphql.json", method: "POST", body: { query: document, variables } },
    ]);
    const encoded = JSON.stringify(server.batches);
    for (const secret of [privateValue, config.storeName, config.storefrontAccessToken, document]) {
      expect(encoded).not.toContain(secret);
    }
  });

  it("retains ERROR severity for a mixed internal/throttled response, with one log", async () => {
    server.body = JSON.stringify({
      errors: ["THROTTLED", "INTERNAL_SERVER_ERROR", "THROTTLED"].map((code) => ({
        extensions: { code },
      })),
    });
    await expect(server.client.storefront.query("{ shop { name } }")).rejects.toBeInstanceOf(
      ShopifyError,
    );
    await server.pipeline.flush();
    expect(server.logs()).toMatchObject([{ severityText: "ERROR" }]);
    expect(attributes(server.logs()[0]!)).toMatchObject({
      operation: "storefront.graphql",
      "error.code": "THROTTLED,INTERNAL_SERVER_ERROR",
    });
  });

  it.each([
    ["null", "INVALID_RESPONSE"],
    ["[]", "INVALID_RESPONSE"],
    ['"private-body"', "INVALID_RESPONSE"],
    ['{"errors":"private-body"}', "INVALID_RESPONSE"],
    ['{"data":[]}', "INVALID_RESPONSE"],
    ['{"data":null}', "MISSING_DATA"],
    ["{}", "MISSING_DATA"],
    ['{"errors":[null]}', "UNKNOWN"],
    ["<html>private-body</html>", "INVALID_JSON"],
  ])("sanitizes malformed response %s as %s", async (body, code) => {
    server.body = body;
    await expect(server.client.storefront.query("{ shop { name } }")).rejects.toMatchObject({
      name: "ShopifyError",
      status: 200,
      codes: [code],
    });
    await server.pipeline.flush();
    expect(server.logs()).toMatchObject([{ severityText: "ERROR" }]);
    expect(attributes(server.logs()[0]!)["error.code"]).toBe(code);
    expect(JSON.stringify(server.batches)).not.toContain("private-body");
  });

  it("replaces arbitrary upstream codes before logging or throwing", async () => {
    server.body = JSON.stringify({
      errors: [{ message: privateValue, extensions: { code: privateValue } }],
    });
    const error = await server.client.storefront.query("{ shop { name } }").catch((e) => e);
    expect(error).toBeInstanceOf(ShopifyError);
    if (!(error instanceof ShopifyError)) throw error;
    expect(error.codes).toEqual(["UNKNOWN"]);
    expect(error.message).not.toContain(privateValue);
    await server.pipeline.flush();
    expect(attributes(server.logs()[0]!)["error.code"]).toBe("UNKNOWN");
    expect(JSON.stringify(server.batches)).not.toContain(privateValue);
  });

  it.each([
    [503, "ERROR"],
    [429, "WARN"],
    [400, "WARN"],
  ])("keeps HTTP %s on the shared fetch path, with one %s log", async (status, severity) => {
    server.status = status;
    server.body = JSON.stringify({ errors: [{ extensions: { code: "INTERNAL_SERVER_ERROR" } }] });
    await expect(
      server.client.storefront.query("query Cart { cart { id } }"),
    ).rejects.toMatchObject({
      status,
      codes: [],
    });
    await server.pipeline.flush();
    expect(server.logs()).toMatchObject([{ severityText: severity }]);
    expect(server.requests).toHaveLength(1);
  });

  it("returns successful mutation data and validation errors unchanged, without logging", async () => {
    const data = {
      cartCreate: {
        cart: null,
        userErrors: [{ message: privateValue, code: "INVALID" }],
        customerUserErrors: [{ message: privateValue }],
        warnings: [{ code: "MERCHANDISE_NOT_ENOUGH_STOCK" }],
      },
    };
    server.body = JSON.stringify({ data, errors: [] });
    expect(
      await server.client.storefront.query("mutation Cart { cartCreate { cart { id } } }"),
    ).toEqual(data);
    await server.pipeline.flush();
    expect(server.logs()).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    "sampled-out",
    "disabled",
    "no-CMS",
  ])("preserves rejected responses with %s telemetry and exports nothing", async (mode) => {
    if (mode === "no-CMS") setCurrentTelemetry(undefined);
    else {
      server.pipeline.apply({
        enabled: mode !== "disabled",
        errorSampleRate: mode === "sampled-out" ? 0 : 1,
        metrics: false,
      });
    }
    server.body = JSON.stringify({ errors: [{ extensions: { code: "THROTTLED" } }] });
    await expect(server.client.storefront.query("{ shop { name } }")).rejects.toMatchObject({
      codes: ["THROTTLED"],
    });
    await server.pipeline.flush();
    expect(server.batches).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });
});
