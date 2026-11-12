// @vitest-environment node
/**
 * createInstrumentedFetch (api-reference#createinstrumentedfetch-options,
 * upstream-clients.mdx): one measurement per request, retries counted once,
 * an opt-in circuit breaker, and nothing measured without telemetry.
 */
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetForTests } from "./cms";
import { createInstrumentedFetch } from "./fetch";
import { resolveDestination, setCurrentTelemetry, TelemetryPipeline } from "./telemetry";

/** A stand-in pipeline recording what the fetch reports. */
function recorder() {
  const histograms: { name: string; labels: Record<string, unknown> }[] = [];
  const errors: { message: string; attributes: Record<string, unknown> }[] = [];
  setCurrentTelemetry({
    histogram: (name: string, labels: Record<string, unknown>) => histograms.push({ name, labels }),
    error: (message: string, attributes: Record<string, unknown>) =>
      errors.push({ message, attributes }),
    sampleTrace: () => false,
    span: () => {},
  } as unknown as TelemetryPipeline);
  return { histograms, errors };
}

/** An upstream answering with `statuses` in order (a thrown error for "throw"). */
function upstream(statuses: (number | "throw")[]) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const next = statuses.shift() ?? 200;
    if (next === "throw") throw new TypeError("connection reset");
    return new Response("{}", { status: next });
  });
}

beforeEach(() => resetForTests());
afterEach(() => resetForTests());

describe("createInstrumentedFetch", () => {
  it("measures each request with provider, operation, status_class, cached and retries labels", async () => {
    const { histograms } = recorder();
    const fetch = upstream([404]);
    const request = createInstrumentedFetch({ provider: "acme-search", fetch });
    const response = await request("https://api.acme.example/v1/search?q=x", {
      operation: "search",
      headers: { authorization: "Bearer k" },
    });
    expect(response.status).toBe(404);
    expect(fetch.mock.calls[0]?.[1]).toEqual({ headers: { authorization: "Bearer k" } }); // operation stays out
    expect(histograms).toEqual([
      {
        name: "http.client.request.duration",
        labels: {
          provider: "acme-search",
          operation: "search",
          status_class: "4xx",
          cached: false,
          retries: 0,
        },
      },
    ]);
  });

  it("an upstream cache is the fetch option; a response it marks x-cache: HIT is measured cached", async () => {
    const { histograms } = recorder();
    // The Workers recipe (/next/caching#upstream-data), with a Map for the Cache API.
    const store = new Map<string, Response>();
    const origin = upstream([200]);
    const cachedFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const hit = store.get(url);
      if (hit) {
        const response = new Response(hit.clone().body, hit);
        response.headers.set("x-cache", "HIT");
        return response;
      }
      const response = await origin(input, init);
      store.set(url, response.clone());
      return response;
    };
    const request = createInstrumentedFetch({ provider: "p", fetch: cachedFetch });
    await request("https://api.example/a");
    await request("https://api.example/a");
    expect(origin).toHaveBeenCalledTimes(1);
    expect(histograms.map((h) => h.labels.cached)).toEqual([false, true]);
  });

  it("works with no telemetry configured, measuring nothing", async () => {
    const request = createInstrumentedFetch({ provider: "p", fetch: upstream([200]) });
    expect((await request("https://x.example")).status).toBe(200);
  });

  it("doesn't retry unless asked", async () => {
    const fetch = upstream([503, 200]);
    const request = createInstrumentedFetch({ provider: "p", fetch });
    expect((await request("https://x.example")).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries rate limits, gateway errors and network errors, measured once with the retry count", async () => {
    const { histograms } = recorder();
    const fetch = upstream([503, "throw", 200]);
    const request = createInstrumentedFetch({
      provider: "p",
      fetch,
      retry: { attempts: 2, backoffMs: 1 },
    });
    expect((await request("https://x.example", { operation: "get" })).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(histograms).toHaveLength(1);
    expect(histograms[0]?.labels).toMatchObject({ status_class: "2xx", retries: 2 });
  });

  it("never retries a request that isn't safe to repeat", async () => {
    const fetch = upstream([503, 200]);
    const request = createInstrumentedFetch({ provider: "p", fetch, retry: { attempts: 3 } });
    expect((await request("https://x.example", { method: "POST" })).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rethrows a network failure after logging it, without the URL's query", async () => {
    const { histograms, errors } = recorder();
    const request = createInstrumentedFetch({ provider: "p", fetch: upstream(["throw"]) });
    await expect(request("https://x.example/?token=abc", { operation: "op" })).rejects.toThrow(
      "connection reset",
    );
    expect(histograms[0]?.labels.status_class).toBe("error");
    expect(errors[0]?.attributes).toEqual({
      "error.code": "FETCH_FAILED",
      provider: "p",
      operation: "op",
    });
    expect(errors[0]?.message).not.toContain("token=abc");
  });

  it("opens the circuit after consecutive failures, failing fast until the cooldown ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    const fetch = upstream([500, 500, 200, 200]);
    const request = createInstrumentedFetch({
      provider: "p",
      fetch,
      circuitBreaker: { failures: 2, cooldownMs: 30_000 },
    });
    await request("https://x.example");
    await request("https://x.example");
    await expect(request("https://x.example")).rejects.toThrow(/circuit open/);
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-10-03T00:00:30Z"));
    expect((await request("https://x.example")).status).toBe(200);
    expect((await request("https://x.example")).status).toBe(200);
    vi.useRealTimers();
  });
});

interface ExportedLog {
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: {
    key: string;
    value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
  }[];
}

interface LogsBatch {
  resourceLogs: { scopeLogs: { logRecords: ExportedLog[] }[] }[];
}

/** Real upstream responses and a local HTTP collector for the actual OTLP exporter. */
async function responseLoggingServer() {
  const state = {
    statuses: [] as number[],
    calls: [] as { method: string; url: string }[],
    batches: [] as LogsBatch[],
    encoded: [] as string[],
    collectorErrors: [] as unknown[],
    body: "upstream response body",
    statusText: undefined as string | undefined,
    cached: false,
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/v1/logs") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const text = (
          request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes
        ).toString();
        state.encoded.push(text);
        state.batches.push(JSON.parse(text) as LogsBatch);
        response.end("{}");
        return;
      }
      state.calls.push({ method: request.method ?? "GET", url: request.url ?? "" });
      response.statusCode = state.statuses.shift() ?? 200;
      if (state.statusText !== undefined) response.statusMessage = state.statusText;
      if (state.cached) response.setHeader("x-cache", "HIT");
      response.end(state.body);
    })().catch((error: unknown) => {
      state.collectorErrors.push(error);
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test server port");
  return Object.assign(state, {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  });
}

function exportedLogs(server: Awaited<ReturnType<typeof responseLoggingServer>>): ExportedLog[] {
  expect(server.collectorErrors).toEqual([]);
  return server.batches.flatMap((batch) =>
    batch.resourceLogs.flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) => scope.logRecords),
    ),
  );
}

function logAttributes(log: ExportedLog): Record<string, string | number | boolean | undefined> {
  return Object.fromEntries(
    log.attributes.map(({ key, value }) => [
      key,
      value.stringValue ??
        value.boolValue ??
        (value.intValue !== undefined ? Number(value.intValue) : value.doubleValue),
    ]),
  );
}

describe("upstream response logs through the real telemetry exporter", () => {
  let server: Awaited<ReturnType<typeof responseLoggingServer>>;
  let pipeline: TelemetryPipeline;

  beforeEach(async () => {
    server = await responseLoggingServer();
    const destination = resolveDestination({ endpoint: server.origin }, "test-site");
    if (destination === null) throw new Error("Missing test telemetry destination");
    pipeline = new TelemetryPipeline(destination);
    pipeline.apply({ errorSampleRate: 1, traceSampleRate: 0, metrics: false });
    setCurrentTelemetry(pipeline);
  });

  afterEach(async () => {
    await server.close();
  });

  it("keeps recovered retries out of error logs", async () => {
    server.statuses.push(503, 200);
    const request = createInstrumentedFetch({
      provider: "vtex",
      retry: { attempts: 2, backoffMs: 0 },
    });
    const response = await request(`${server.origin}/upstream`, {
      operation: "catalog.category.tree",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(server.body);
    expect(server.calls).toHaveLength(2);
    await pipeline.flush();
    expect(exportedLogs(server)).toEqual([]);
  });

  it("exports one final error after exhausting retries, with request metadata", async () => {
    server.statuses.push(503, 503, 503);
    const request = createInstrumentedFetch({
      provider: "vtex",
      retry: { attempts: 2, backoffMs: 0 },
    });
    const response = await request(`${server.origin}/upstream`, {
      operation: "catalog.category.tree",
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(server.body);
    expect(server.calls).toHaveLength(3);
    await pipeline.flush();
    const logs = exportedLogs(server);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      severityNumber: 17,
      severityText: "ERROR",
      body: { stringValue: "vtex catalog.category.tree failed with HTTP 503" },
    });
    expect(logAttributes(logs[0]!)).toEqual({
      "error.code": "FETCH_HTTP_ERROR",
      provider: "vtex",
      operation: "catalog.category.tree",
      "http.request.method": "GET",
      "http.response.status_code": 503,
      retries: 2,
      cached: false,
    });
  });

  it.each([500, 599])("logs the final HTTP %i as an error", async (status) => {
    server.statuses.push(status);
    const request = createInstrumentedFetch({ provider: "vtex" });
    expect((await request(`${server.origin}/upstream`)).status).toBe(status);
    await pipeline.flush();
    expect(exportedLogs(server)).toMatchObject([{ severityNumber: 17, severityText: "ERROR" }]);
  });

  it.each([
    400, 405, 408, 422, 429,
  ])("exports HTTP %i as a warning without retrying a write", async (status) => {
    server.statuses.push(status);
    const request = createInstrumentedFetch({
      provider: "vtex",
      retry: { attempts: 2, backoffMs: 0 },
    });
    const response = await request(`${server.origin}/upstream`, {
      operation: "checkout.orderform.items.add",
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(status);
    expect(server.calls).toHaveLength(1);
    await pipeline.flush();
    const logs = exportedLogs(server);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ severityNumber: 13, severityText: "WARN" });
    expect(logAttributes(logs[0]!)).toMatchObject({
      "error.code": "FETCH_HTTP_WARNING",
      "http.request.method": "POST",
      "http.response.status_code": status,
      retries: 0,
    });
  });

  it("exports an exhausted rate limit once as a warning", async () => {
    server.statuses.push(429, 429, 429);
    const request = createInstrumentedFetch({
      provider: "vtex",
      retry: { attempts: 2, backoffMs: 0 },
    });
    expect((await request(`${server.origin}/upstream`)).status).toBe(429);
    expect(server.calls).toHaveLength(3);
    await pipeline.flush();
    const logs = exportedLogs(server);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ severityNumber: 13, severityText: "WARN" });
    expect(logAttributes(logs[0]!)).toMatchObject({ retries: 2 });
  });

  it.each([
    200, 204, 302, 304, 401, 403, 404, 409, 410, 418,
  ])("keeps HTTP %i out of response logs", async (status) => {
    server.statuses.push(status);
    const request = createInstrumentedFetch({ provider: "vtex" });
    expect((await request(`${server.origin}/upstream`)).status).toBe(status);
    await pipeline.flush();
    expect(exportedLogs(server)).toEqual([]);
  });

  it.each([401, 403])("keeps normal signed-out HTTP %i results quiet", async (status) => {
    server.statuses.push(status);
    const request = createInstrumentedFetch({ provider: "wake" });
    const response = await request(`${server.origin}/upstream`, { operation: "getLogin" });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(server.body);
    await pipeline.flush();
    expect(exportedLogs(server)).toEqual([]);
  });

  it.each([
    { enabled: false, errorSampleRate: 1 },
    { enabled: true, errorSampleRate: 0 },
  ])("respects telemetry and sampling settings: %j", async (settings) => {
    pipeline.apply({ ...settings, metrics: false, traceSampleRate: 0 });
    server.statuses.push(503, 400);
    const request = createInstrumentedFetch({ provider: "vtex" });
    await request(`${server.origin}/upstream`);
    await request(`${server.origin}/upstream`);
    await pipeline.flush();
    expect(exportedLogs(server)).toEqual([]);
  });

  it("works without a telemetry destination", async () => {
    setCurrentTelemetry(undefined);
    server.statuses.push(503, 400);
    const request = createInstrumentedFetch({ provider: "vtex" });
    expect((await request(`${server.origin}/upstream`)).status).toBe(503);
    expect((await request(`${server.origin}/upstream`)).status).toBe(400);
    await pipeline.flush();
    expect(exportedLogs(server)).toEqual([]);
  });

  it("exports no URL, shopper input, headers, response text or body and leaves the body readable", async () => {
    server.statuses.push(502);
    server.statusText = "private-status-text";
    server.body = '{"email":"shopper@example.test","secret":"private-response-body"}';
    server.cached = true;
    const request = createInstrumentedFetch({ provider: "vtex" });
    const response = await request(`${server.origin}/upstream/shopper-123?token=query-secret`, {
      operation: "checkout.orderform.items.add",
      method: "POST",
      headers: {
        authorization: "Bearer authorization-secret",
        cookie: "session=cookie-secret",
        "x-vtex-api-apptoken": "app-token-secret",
      },
      body: '{"password":"request-body-secret"}',
    });
    expect(await response.text()).toBe(server.body);
    await pipeline.flush();
    const logs = exportedLogs(server);
    expect(logs).toHaveLength(1);
    expect(logAttributes(logs[0]!)).toMatchObject({ cached: true });
    const encoded = server.encoded.join("\n");
    for (const sensitive of [
      server.origin,
      "shopper-123",
      "query-secret",
      "authorization-secret",
      "cookie-secret",
      "app-token-secret",
      "request-body-secret",
      "private-status-text",
      "private-response-body",
      "shopper@example.test",
    ]) {
      expect(encoded).not.toContain(sensitive);
    }
  });
});
