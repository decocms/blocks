// @vitest-environment node
/**
 * Telemetry (telemetry.mdx, telemetry-internals.mdx, hosted-telemetry.mdx):
 * where it goes, what the Telemetry block and limits allow, the OTLP/HTTP
 * JSON wire format, background sending and scrubbing.
 */
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "./cms";
import { createInstrumentedFetch } from "./fetch";
import { currentTelemetry, resolveDestination } from "./telemetry";
import { docsBlocks, docsSnapshot } from "./testFixtures";
import type { Snapshot, TelemetryConfig } from "./types";

const ENDPOINT = "https://otel.example.com";
const HOSTED_TELEMETRY_ENDPOINT = "https://otel.decocms.com";
/** Where a framework binding installs its background runner (Workers: ctx.waitUntil). */
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
    blocks: { ...snapshot.blocks, Telemetry: { __resolveType: "telemetry", ...block } },
  };
}

/** An upstream that answers 200, for measurements to have something to measure. */
const upstream = createInstrumentedFetch({
  provider: "acme-search",
  fetch: async () => new Response("{}", { status: 200 }),
});

describe("where telemetry goes", () => {
  it("false sends nothing; an endpoint sends there; site and token go to the hosted collector", () => {
    expect(resolveDestination(false)).toBeNull();
    expect(
      resolveDestination({ endpoint: ENDPOINT, headers: { authorization: "Bearer t" } }),
    ).toMatchObject({ endpoint: ENDPOINT, headers: { authorization: "Bearer t" } });
    expect(resolveDestination({ site: "acme", token: "tok" })).toMatchObject({
      endpoint: HOSTED_TELEMETRY_ENDPOINT,
      headers: { authorization: "Bearer tok" },
      site: "acme",
    });
  });

  it("unset values (an environment variable that isn't set) turn it off instead of throwing", () => {
    expect(
      resolveDestination({ site: undefined, token: undefined } as unknown as TelemetryConfig),
    ).toBeNull();
    expect(resolveDestination({ endpoint: "" })).toBeNull();
  });

  it("left out, it reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS, or sends nothing", () => {
    expect(resolveDestination(undefined)).toBeNull();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", ENDPOINT);
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "x-team=store,authorization=Bearer%20abc");
    expect(resolveDestination(undefined)).toMatchObject({
      endpoint: ENDPOINT,
      headers: { "x-team": "store", authorization: "Bearer abc" },
    });
  });

  it("top-level site and token never turn telemetry on", async () => {
    const { fetch } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: "acme", token: "tok" });
    expect(currentTelemetry()).toBeUndefined();
    await upstream("https://search.example/q");
    await runBackground();
    expect(fetch).not.toHaveBeenCalled();
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
    createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      telemetry: { site: "acme", token: "tok" },
    });
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
      telemetry: { endpoint: ENDPOINT, limits: { errorSampleRate: 1 } },
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
      content: docsSnapshot(),
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

  it("samples at the Telemetry block's errorSampleRate, capped by limits (default 0.1)", async () => {
    const { fetch } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: withTelemetryBlock({ errorSampleRate: 1 }),
      telemetry: { endpoint: ENDPOINT },
    });
    const random = vi.spyOn(Math, "random").mockReturnValue(0.2); // above the 0.1 cap
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

describe("traces", () => {
  it("are off by default, even when content asks for them", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withTelemetryBlock({ traceSampleRate: 1 }),
      telemetry: { endpoint: ENDPOINT },
    });
    await cms.forRelease().revision();
    await cms.forRelease().resolve("SummerSEO");
    await runBackground();
    expect(sent.some((s) => s.url.endsWith("/v1/traces"))).toBe(false);
  });

  it("trace block resolution and upstream calls once code raises the limit", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withTelemetryBlock({ traceSampleRate: 1 }),
      telemetry: { endpoint: ENDPOINT, limits: { traceSampleRate: 1 } },
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

  it("with a binding's hook, a batch leaves once it's 10 s old, not after every request", async () => {
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    clock += 10_000; // the first batch window is already open
    await upstream("https://search.example/q");
    await Promise.all(tasks.splice(0).map((task) => task()));
    expect(sent).toHaveLength(1);

    await upstream("https://search.example/q"); // the next request, same window
    await Promise.all(tasks.splice(0).map((task) => task()));
    await upstream("https://search.example/q");
    await Promise.all(tasks.splice(0).map((task) => task()));
    expect(sent).toHaveLength(1);

    clock += 10_000;
    await upstream("https://search.example/q");
    await Promise.all(tasks.splice(0).map((task) => task()));
    expect(sent).toHaveLength(2);
    const point =
      sent[1]?.body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0];
    expect(point.count).toBe("3");
  });

  it("OTEL_RESOURCE_ATTRIBUTES sets service.version and the environment", async () => {
    vi.stubEnv(
      "OTEL_RESOURCE_ATTRIBUTES",
      "service.version=abc123,deployment.environment.name=preview",
    );
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstream("https://search.example/q");
    await runBackground();
    expect(attrs(sent[0]?.body.resourceMetrics[0].resource.attributes)).toMatchObject({
      "service.name": "decocms-site",
      "service.version": "abc123",
      "deployment.environment.name": "preview",
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
});
