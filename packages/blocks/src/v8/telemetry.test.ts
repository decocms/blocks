// @vitest-environment node
/**
 * Telemetry (telemetry.mdx, telemetry-internals.mdx, hosted-telemetry.mdx):
 * where it goes, what the Telemetry block and code's defaults set, the OTLP/HTTP
 * JSON wire format, background sending and scrubbing.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "./cms";
import { createInstrumentedFetch } from "./fetch";
import { currentTelemetry, resolveDestination, TelemetryPipeline } from "./telemetry";
import { docsBlocks, docsSnapshot } from "./testFixtures";
import type { Snapshot, TelemetryConfig } from "./types";

const ENDPOINT = "https://otel.example.com";
const HOSTED_TELEMETRY_ENDPOINT = "https://otel.decocms.com";
/** Where the host installs its background runner (Workers: ctx.waitUntil). */
const BACKGROUND_HOOK = Symbol.for("decocms.blocks.background");

/** Background tasks a binding would run after the response; the test runs them on demand. */
let tasks: (() => Promise<void>)[] = [];
/** Milliseconds added to Date.now(): batches leave only once they're 10 s old. */
let clock = 0;

beforeEach(() => {
  resetForTests();
  tasks = [];
  clock = 0;
  const now = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => now() + clock);
  (globalThis as Record<symbol, unknown>)[BACKGROUND_HOOK] = (task: () => Promise<void>) =>
    tasks.push(task);
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[BACKGROUND_HOOK];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Runs the queued tasks as the next responses would, each pass one batch window (10 s) later. */
async function runBackground(): Promise<void> {
  while (tasks.length > 0) {
    clock += 10_000;
    await Promise.all(tasks.splice(0).map((task) => task()));
  }
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A collector that records every batch; `statuses` answers the next sends in order. */
function collector(statuses: number[] = []) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = Buffer.from(init?.body as Uint8Array);
    const text = headers["content-encoding"] === "gzip" ? gunzipSync(raw).toString() : String(raw);
    sent.push({ url: String(input), headers, body: JSON.parse(text) });
    return new Response(null, { status: statuses.shift() ?? 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return { sent, fetch };
}

function attrs(list: { key: string; value: Record<string, unknown> }[]): Record<string, unknown> {
  return Object.fromEntries(list.map(({ key, value }) => [key, Object.values(value)[0]]));
}

function withTelemetryBlock(block: Record<string, unknown>): Snapshot {
  const snapshot = docsSnapshot();
  return {
    ...snapshot,
    blocks: { ...snapshot.blocks, CMS: { __resolveType: "cms-settings", telemetry: block } },
  };
}

/** An upstream that answers 200, for measurements to have something to measure. */
const upstream = createInstrumentedFetch({
  provider: "acme-search",
  fetch: async () => new Response("{}", { status: 200 }),
});

describe("where telemetry goes", () => {
  it("false sends nothing; an endpoint sends there; otherwise a token goes to the hosted collector", () => {
    expect(resolveDestination(false, "acme", "tok")).toBeNull();
    expect(
      resolveDestination({ endpoint: ENDPOINT, headers: { authorization: "Bearer t" } }),
    ).toMatchObject({ endpoint: ENDPOINT, headers: { authorization: "Bearer t" } });
    expect(resolveDestination(undefined, "acme", "tok")).toMatchObject({
      endpoint: HOSTED_TELEMETRY_ENDPOINT,
      headers: { authorization: "Bearer tok" },
      site: "acme",
    });
    expect(resolveDestination({ defaults: { traceSampleRate: 1 } }, "acme", "tok")).toMatchObject({
      endpoint: HOSTED_TELEMETRY_ENDPOINT,
      defaults: { traceSampleRate: 1 },
    });
  });

  it("an explicit endpoint wins over the token: the token isn't sent there", () => {
    const destination = resolveDestination({ endpoint: ENDPOINT }, "acme", "tok");
    expect(destination).toMatchObject({ endpoint: ENDPOINT, headers: {} });
  });

  it("nothing set is off: no endpoint and no token, or empty values", () => {
    expect(resolveDestination(undefined)).toBeNull();
    expect(resolveDestination({})).toBeNull();
    expect(resolveDestination({ endpoint: "" })).toBeNull();
    expect(resolveDestination(undefined, "acme", "")).toBeNull();
    expect(resolveDestination({ endpoint: "" } as TelemetryConfig, "acme")).toBeNull();
  });

  it("reads no environment variable: OTEL_* and DECO_OTEL_* change nothing", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", ENDPOINT);
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer%20abc");
    vi.stubEnv("DECO_OTEL_METRICS_ENDPOINT", `${ENDPOINT}/v1/metrics`);
    vi.stubEnv("DECO_OTEL_AUTH_TOKEN", "Bearer v7");
    expect(resolveDestination(undefined)).toBeNull();
    const { fetch } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    expect(currentTelemetry()).toBeUndefined();
    await upstream("https://search.example/q");
    await runBackground();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("top-level site alone never turns telemetry on", async () => {
    const { fetch } = collector();
    createCMS({ blocks: docsBlocks(), site: "acme" });
    expect(currentTelemetry()).toBeUndefined();
    await upstream("https://search.example/q");
    await runBackground();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a top-level token turns it on to the hosted collector; telemetry: false opts out", async () => {
    createCMS({ blocks: docsBlocks(), site: "acme", token: "tok" });
    expect(currentTelemetry()).toBeDefined();
    resetForTests();
    createCMS({
      blocks: docsBlocks(),
      site: "acme",
      token: "tok",
      telemetry: false,
    });
    expect(currentTelemetry()).toBeUndefined();
  });
});

describe("metrics", () => {
  it("aggregates upstream latency into one delta histogram point per label set, sent as gzipped OTLP JSON", async () => {
    const { sent } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: undefined,
      telemetry: { endpoint: `${ENDPOINT}/`, headers: { "x-key": "k" } },
    });
    await cms.forRelease().revision(); // serving a release labels batches with it
    await upstream("https://search.example/q", { operation: "search" });
    await upstream("https://search.example/q", { operation: "search" });
    await runBackground();

    expect(sent).toHaveLength(1);
    const [batch] = sent;
    expect(batch?.url).toBe(`${ENDPOINT}/v1/metrics`);
    expect(batch?.headers).toMatchObject({
      "content-type": "application/json",
      "content-encoding": "gzip",
      "x-key": "k",
    });
    const resourceMetrics = batch?.body.resourceMetrics[0];
    expect(attrs(resourceMetrics.resource.attributes)).toMatchObject({ "deco.release": "rev-1" });
    const metric = resourceMetrics.scopeMetrics[0].metrics[0];
    expect(metric.name).toBe("http.client.request.duration");
    expect(metric.unit).toBe("s");
    expect(metric.histogram.aggregationTemporality).toBe(1);
    expect(metric.histogram.dataPoints).toHaveLength(1);
    const point = metric.histogram.dataPoints[0];
    expect(point.count).toBe("2");
    expect(attrs(point.attributes)).toEqual({
      provider: "acme-search",
      operation: "search",
      status_class: "2xx",
      cached: false,
      retries: "0",
    });
    expect(point.bucketCounts.length).toBe(point.explicitBounds.length + 1);
  });

  it("labels batches with the site and service name for the hosted collector", async () => {
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), site: "acme", token: "tok" });
    await upstream("https://search.example/q");
    await runBackground();
    expect(sent[0]?.url).toBe(`${HOSTED_TELEMETRY_ENDPOINT}/v1/metrics`);
    expect(sent[0]?.headers.authorization).toBe("Bearer tok");
    expect(attrs(sent[0]?.body.resourceMetrics[0].resource.attributes)).toMatchObject({
      "service.name": "acme",
      "deco.site": "acme",
    });
  });

  it("a Telemetry block with metrics: false sends no metrics; enabled: false sends nothing", async () => {
    const { fetch } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withTelemetryBlock({ metrics: false }),
      telemetry: { endpoint: ENDPOINT },
    });
    await cms.forRelease().revision();
    await upstream("https://search.example/q");
    await runBackground();
    expect(fetch).not.toHaveBeenCalled();

    resetForTests();
    const off = createCMS({
      blocks: {
        ...docsBlocks(),
        broken: () => {
          throw new Error("boom");
        },
      },
      content: {
        ...withTelemetryBlock({ enabled: false, errorSampleRate: 1 }),
        root: "off",
      },
      telemetry: { endpoint: ENDPOINT, defaults: { errorSampleRate: 1 } },
    });
    await off.forRelease().resolve({ __resolveType: "broken" });
    await upstream("https://search.example/q");
    await runBackground();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("error logs", () => {
  const broken = () => {
    throw new Error(
      "upstream said no: authorization: Bearer sk_live_123 at https://api.example/x?token=abc&q=1 " +
        'cookie=session=1; token: "xyz" password=hunter2 (Bearer abc.def)',
    );
  };

  it("logs a failed block with its code and type, scrubbed", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: docsSnapshot(),
      telemetry: { endpoint: ENDPOINT },
    });
    const [, error] = await cms.forRelease().resolve({ __resolveType: "broken" });
    expect(error?.code).toBe("BLOCK_FAILED");
    await runBackground();

    const logs = sent.find((s) => s.url.endsWith("/v1/logs"));
    const record = logs?.body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.severityText).toBe("ERROR");
    expect(attrs(record.attributes)).toEqual({
      "error.code": "BLOCK_FAILED",
      "deco.block.type": "broken",
    });
    const body: string = record.body.stringValue;
    expect(body).toContain("upstream said no");
    expect(body).not.toContain("sk_live_123");
    for (const secret of ["token=abc", "session=1", "xyz", "hunter2", "abc.def"]) {
      expect(body).not.toContain(secret);
    }
    expect(body).toContain("https://api.example/x?[redacted]");
  });

  it("logs a resolution error once per client, and never NOT_FOUND", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      telemetry: { endpoint: ENDPOINT },
    });
    const client = cms.forRelease();
    await client.resolve("NoSuchBlock");
    await client.resolve({ __resolveType: "no-such-type" });
    await runBackground();
    const records = sent.flatMap((s) => s.body.resourceLogs?.[0].scopeLogs[0].logRecords ?? []);
    expect(records.map((r: any) => attrs(r.attributes)["error.code"])).toEqual(["UNKNOWN_BLOCK"]);
  });

  it("a failed loader logs a fixed message, never the draft pointer it was given", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    vi.stubGlobal(
      "fetch",
      (() => {
        const send = globalThis.fetch;
        return (input: string | URL | Request, init?: RequestInit) =>
          String(input).startsWith(ENDPOINT)
            ? send(input, init)
            : Promise.reject(new Error("down"));
      })(),
    );
    const pointer = "not-a-pointer-secret-abc123";
    const cms = createCMS({
      blocks: docsBlocks(),
      site: "acme",
      token: "tok",
      telemetry: { endpoint: ENDPOINT },
    });
    const [, error] = await cms.forDraft(pointer).resolve("SummerSEO");
    expect(error?.code).toBe("LOADER_FAILED");
    await runBackground();
    const records = sent.flatMap((s) => s.body.resourceLogs?.[0].scopeLogs[0].logRecords ?? []);
    expect(records.map((r: any) => r.body.stringValue)).toEqual(["content loader failed"]);
    expect(JSON.stringify(sent)).not.toContain(pointer);
  });

  it("samples at the Telemetry block's errorSampleRate, which wins over code's defaults", async () => {
    const { fetch } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: withTelemetryBlock({ errorSampleRate: 0.1 }),
      telemetry: { endpoint: ENDPOINT, defaults: { errorSampleRate: 1 } },
    });
    const random = vi.spyOn(Math, "random").mockReturnValue(0.2); // above the block's 0.1
    await cms.forRelease().resolve({ __resolveType: "broken" });
    await runBackground();
    expect(fetch).not.toHaveBeenCalled();

    random.mockReturnValue(0.05);
    await cms.forRelease().resolve({ __resolveType: "broken" });
    await runBackground();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("defaults to a 5% error sample rate without a Telemetry block", async () => {
    const { fetch } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: docsSnapshot(),
      telemetry: { endpoint: ENDPOINT },
    });
    vi.spyOn(Math, "random").mockReturnValue(0.06);
    await cms.forRelease().resolve({ __resolveType: "broken" });
    await runBackground();
    expect(fetch).not.toHaveBeenCalled();
  });
});

interface WireLog {
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: { key: string; value: Record<string, unknown> }[];
}

interface WireLogs {
  resourceLogs: { scopeLogs: { logRecords: WireLog[] }[] }[];
}

/** Real HTTP collector: assertions inspect the bytes the pipeline exported. */
async function withLogCollector(
  check: (pipeline: TelemetryPipeline, payloads: string[]) => Promise<void>,
): Promise<void> {
  const payloads: string[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      payloads.push(
        request.headers["content-encoding"] === "gzip"
          ? gunzipSync(body).toString()
          : body.toString(),
      );
      response.end();
    } catch (error) {
      failures.push(error);
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const destination = resolveDestination({ endpoint, defaults: { errorSampleRate: 1 } });
    if (destination === null) throw new Error("Collector destination missing");
    await check(new TelemetryPipeline(destination), payloads);
    expect(failures).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function wireLogs(payloads: string[]): WireLog[] {
  return payloads.flatMap((payload) =>
    (JSON.parse(payload) as WireLogs).resourceLogs.flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) => scope.logRecords),
    ),
  );
}

describe("warning and error logs over OTLP", () => {
  it.each([
    "warn",
    "error",
  ] as const)("exports a lone %s after an immediately started host hook, without another request", async (severity) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(0);
    await withLogCollector(async (pipeline, payloads) => {
      pipeline[severity]("only request", {});
      expect(tasks).toHaveLength(1);
      // Start the host task while the batch is young: do not advance its age
      // before invoking it, as runBackground() does for the encoding tests.
      const background = Promise.all(tasks.splice(0).map((task) => task()));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(payloads).toEqual([]);
      expect(tasks).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await background;
      expect(wireLogs(payloads)).toMatchObject([
        {
          severityText: severity.toUpperCase(),
          body: { stringValue: "only request" },
        },
      ]);
      expect(payloads).toHaveLength(1);
    });
  });

  it("exports distinct severities and scrubs warning messages and attributes", async () => {
    await withLogCollector(async (pipeline, payloads) => {
      pipeline.warn(
        "upstream refused https://api.example/items?token=warn-query-secret authorization: Bearer warn-auth-secret",
        {
          "http.response.status_code": 429,
          detail: "cookie=warn-cookie-secret",
        },
      );
      pipeline.error("upstream unavailable", { "http.response.status_code": 503 });
      await pipeline.flush();
      const logs = wireLogs(payloads);
      expect(logs.map((log) => [log.severityNumber, log.severityText])).toEqual([
        [13, "WARN"],
        [17, "ERROR"],
      ]);
      expect(attrs(logs[0]!.attributes)["http.response.status_code"]).toBe("429");
      expect(logs[0]!.body.stringValue).toContain("https://api.example/items?[redacted]");
      for (const secret of ["warn-query-secret", "warn-auth-secret", "warn-cookie-secret"]) {
        expect(payloads.join("\n")).not.toContain(secret);
      }
    });
  });

  it.each([
    ["sampling off", { errorSampleRate: 0 }],
    ["telemetry off", { enabled: false, errorSampleRate: 1 }],
  ])("does not export warnings or errors with %s", async (_, settings) => {
    await withLogCollector(async (pipeline, payloads) => {
      pipeline.apply(settings);
      pipeline.warn("warning", {});
      pipeline.error("error", {});
      expect(tasks).toHaveLength(0);
      await pipeline.flush();
      expect(payloads).toEqual([]);
    });
  });

  it("keeps the buffer bounded while replacing the oldest warnings with errors", async () => {
    await withLogCollector(async (pipeline, payloads) => {
      for (let index = 0; index < 200; index++) pipeline.warn(`warning-${index}`, {});
      pipeline.error("first-error", {});
      pipeline.warn("overflow-warning", {});
      pipeline.error("second-error", {});
      await pipeline.flush();
      const logs = wireLogs(payloads);
      const messages = logs.map((log) => log.body.stringValue);
      expect(logs).toHaveLength(200);
      expect(logs.filter((log) => log.severityText === "WARN")).toHaveLength(198);
      expect(messages).toContain("first-error");
      expect(messages).toContain("second-error");
      for (const dropped of ["warning-0", "warning-1", "overflow-warning"]) {
        expect(messages).not.toContain(dropped);
      }
    });
  });

  it("never evicts a buffered error for a warning or another error", async () => {
    await withLogCollector(async (pipeline, payloads) => {
      for (let index = 0; index < 200; index++) pipeline.error(`error-${index}`, {});
      pipeline.warn("overflow-warning", {});
      pipeline.error("overflow-error", {});
      await pipeline.flush();
      const logs = wireLogs(payloads);
      expect(logs).toHaveLength(200);
      expect(logs.every((log) => log.severityNumber === 17)).toBe(true);
      expect(logs.map((log) => log.body.stringValue)).toEqual(
        Array.from({ length: 200 }, (_, index) => `error-${index}`),
      );
    });
  });

  it.each([
    "warn",
    "error",
  ] as const)("exports a full %s buffer after an early host hook", async (severity) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(0);
    await withLogCollector(async (pipeline, payloads) => {
      pipeline.apply({ metrics: false, errorSampleRate: 1, traceSampleRate: 0 });
      for (let index = 0; index < 200; index++) pipeline[severity](`log-${index}`, {});
      const background = Promise.all(tasks.splice(0).map((task) => task()));
      expect(payloads).toEqual([]);
      pipeline[severity]("overflow-log", {});
      expect(tasks).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await background;
      const logs = wireLogs(payloads);
      expect(logs.map((log) => log.body.stringValue)).toEqual(
        Array.from({ length: 200 }, (_, index) => `log-${index}`),
      );
    });
  });

  it("keeps logs recorded after a manual flush while the host task is waiting", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(0);
    await withLogCollector(async (pipeline, payloads) => {
      pipeline.error("before manual flush", {});
      const background = Promise.all(tasks.splice(0).map((task) => task()));
      await vi.advanceTimersByTimeAsync(5_000);
      await pipeline.flush();
      pipeline.warn("after manual flush", {});
      expect(tasks).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await background;
      expect(wireLogs(payloads).map((log) => log.body.stringValue)).toEqual([
        "before manual flush",
        "after manual flush",
      ]);
      expect(payloads).toHaveLength(2);
    });
  });
});

describe("traces", () => {
  it("are off by default, with no rate in content or code", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withTelemetryBlock({}),
      telemetry: { endpoint: ENDPOINT },
    });
    await cms.forRelease().revision();
    await cms.forRelease().resolve("SummerSEO");
    await runBackground();
    expect(sent.some((s) => s.url.endsWith("/v1/traces"))).toBe(false);
  });

  it.each([
    ["content saves traceSampleRate 1", { traceSampleRate: 1 }, undefined],
    ["code's default is 1 and content saves none", {}, { traceSampleRate: 1 }],
  ])("trace block resolution and upstream calls once %s", async (_, block, defaults) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withTelemetryBlock(block),
      telemetry: { endpoint: ENDPOINT, ...(defaults ? { defaults } : {}) },
    });
    await cms.forRelease().revision();
    await cms.forRelease().resolve("SummerSEO");
    await upstream("https://search.example/q", { operation: "search" });
    await runBackground();
    const spans = sent
      .filter((s) => s.url.endsWith("/v1/traces"))
      .flatMap((s) => s.body.resourceSpans[0].scopeSpans[0].spans);
    expect(spans.map((s: any) => s.name).sort()).toEqual(["acme-search search", "seo"]);
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("sending", () => {
  it("retries once on 429/502/503/504, and drops the batch on any other error", async () => {
    const retried = collector([503, 200]);
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstream("https://search.example/q");
    await runBackground(); // waits out the one-second retry delay
    expect(retried.fetch).toHaveBeenCalledTimes(2);

    resetForTests();
    const dropped = collector([400]);
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstream("https://search.example/q");
    await runBackground();
    expect(dropped.fetch).toHaveBeenCalledTimes(1);
  });

  it("a collector that's down loses that batch and never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network down"))),
    );
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstream("https://search.example/q");
    await expect(runBackground()).resolves.toBeUndefined();
  });

  it("with a binding's hook, requests share a batch that leaves after 10 s without another request", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(0);
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await vi.advanceTimersByTimeAsync(10_000); // the first batch window is already open
    await upstream("https://search.example/q");
    await Promise.all(tasks.splice(0).map((task) => task()));
    expect(sent).toHaveLength(1);

    await upstream("https://search.example/q"); // the next request, same window
    const background = Promise.all(tasks.splice(0).map((task) => task()));
    await vi.advanceTimersByTimeAsync(5_000);
    await upstream("https://search.example/q");
    expect(tasks).toHaveLength(0);
    expect(sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await background;
    expect(sent).toHaveLength(2);
    const point =
      sent[1]?.body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0];
    expect(point.count).toBe("2");
  });

  it("waits only the remaining batch window when the host starts its task late", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(0);
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstream("https://search.example/q");
    await vi.advanceTimersByTimeAsync(4_000);
    const background = Promise.all(tasks.splice(0).map((task) => task()));
    await vi.advanceTimersByTimeAsync(5_999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await background;
    expect(sent).toHaveLength(1);
  });

  it("waits at most 10 s when the wall clock moves backwards before the host task starts", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(0);
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstream("https://search.example/q");
    vi.setSystemTime(-5_000);
    const background = Promise.all(tasks.splice(0).map((task) => task()));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await background;
    expect(sent).toHaveLength(1);
  });

  it("schedules a new log while the previous batch is still exporting", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(0);
    const { sent, fetch } = collector();
    const collect = fetch.getMockImplementation()!;
    let received!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      received = resolve;
    });
    let respond!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      respond = resolve;
    });
    fetch.mockImplementationOnce(async (input, init) => {
      const response = await collect(input, init);
      received();
      await firstResponse;
      return response;
    });
    createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      telemetry: { endpoint: ENDPOINT, defaults: { errorSampleRate: 1 } },
    });
    const pipeline = currentTelemetry()!;
    pipeline.error("first batch", {});
    const firstBatch = Promise.all(tasks.splice(0).map((task) => task()));
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await firstRequest;
      pipeline.error("during first export", {});
      expect(tasks).toHaveLength(1);
      const secondBatch = Promise.all(tasks.splice(0).map((task) => task()));
      await vi.advanceTimersByTimeAsync(10_000);
      await secondBatch;
      expect(sent).toHaveLength(2);
      expect(
        sent.map((batch) => batch.body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue),
      ).toEqual(["first batch", "during first export"]);
    } finally {
      respond();
      await firstBatch;
    }
  });

  it("defaults the resource to service.version unknown and the production environment", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", "service.version=abc123");
    vi.stubEnv("DECO_COMMIT_SHA", "abc123");
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstream("https://search.example/q");
    await runBackground();
    expect(attrs(sent[0]?.body.resourceMetrics[0].resource.attributes)).toMatchObject({
      "service.name": "decocms-site",
      "service.version": "unknown",
      "deployment.environment.name": "production",
    });
  });

  it("telemetry.resource sets service.version, the environment and the service name", async () => {
    const { sent } = collector();
    createCMS({
      blocks: docsBlocks(),
      site: "acme",
      token: "tok",
      telemetry: {
        resource: {
          "service.version": "abc123",
          "deployment.environment.name": "preview",
          "service.name": "acme-web",
        },
      },
    });
    await upstream("https://search.example/q");
    await runBackground();
    expect(sent[0]?.url).toBe(`${HOSTED_TELEMETRY_ENDPOINT}/v1/metrics`);
    expect(attrs(sent[0]?.body.resourceMetrics[0].resource.attributes)).toMatchObject({
      "service.name": "acme-web",
      "service.version": "abc123",
      "deployment.environment.name": "preview",
      "deco.site": "acme",
    });
  });

  it("without a binding's hook, batches go out on a timer, not per measurement", async () => {
    delete (globalThis as Record<symbol, unknown>)[BACKGROUND_HOOK];
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { fetch } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstream("https://search.example/q");
    await upstream("https://search.example/q");
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it("on Workers with no hook yet, waitUntil keeps a lone log alive through the batch window", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(0);
    // Exercise the automatic cloudflare:workers bootstrap, without a binding
    // installing the hook or another request arriving to trigger the export.
    delete (globalThis as Record<symbol, unknown>)[BACKGROUND_HOOK];
    const queued: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => void queued.push(promise));
    vi.doMock("cloudflare:workers", () => ({ waitUntil }));
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.resetModules();
    try {
      const { sent, fetch } = collector();
      const cms = await import("./cms");
      const instrumented = await import("./fetch");
      cms.createCMS({
        blocks: docsBlocks(),
        content: docsSnapshot(),
        telemetry: {
          endpoint: ENDPOINT,
          defaults: { errorSampleRate: 1 },
        },
      });
      const workerUpstream = instrumented.createInstrumentedFetch({
        provider: "acme-search",
        fetch: async () => new Response("{}", { status: 503 }),
      });
      await workerUpstream("https://search.example/q");
      // Importing cloudflare:workers completes asynchronously; advance no
      // clock time while letting that bootstrap register its background task.
      await vi.advanceTimersByTimeAsync(0);
      expect(waitUntil).toHaveBeenCalledTimes(1);
      let settled = false;
      const background = Promise.all(queued.splice(0)).then(() => {
        settled = true;
      });
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await background;
      expect(settled).toBe(true);
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(2); // one metrics batch and one logs batch
      const logs = sent.filter((batch) => batch.url.endsWith("/v1/logs"));
      expect(logs).toHaveLength(1);
      expect(logs[0]?.body.resourceLogs[0].scopeLogs[0].logRecords).toMatchObject([
        { severityText: "ERROR", attributes: expect.any(Array) },
      ]);
    } finally {
      vi.doUnmock("cloudflare:workers");
      vi.resetModules();
    }
  });
});
