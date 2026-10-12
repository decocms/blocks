// @vitest-environment node
/**
 * Conformance: telemetry.mdx, hosted-telemetry.mdx, telemetry-internals.mdx,
 * upstream-clients.mdx (the core half) and caching.mdx, checked against
 * `@decocms/blocks`. Each `it` names the claim it checks (tel-*, htel-*,
 * tin-*, up-*, cache-*). The docs are the source of truth: a failing test
 * here is a gap in the code (or, where the report says so, in the docs).
 *
 * The docs' code snippets live, verbatim, in `packages/blocks/conformance/
 * observability/` (outside `src`, so its `.deco` folder can keep the docs'
 * name) and are typechecked here with their own tsconfig.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixture } from "../cli/__tests__/fixture";
import { decoPaths } from "../cli/root";
import { generateSchema } from "../cli/schema/generate";
import { toBase64 } from "../cli/schema/typeToSchema";
import { createCMS, instanceOf, resetForTests } from "../cms";
import { createInstrumentedFetch } from "../fetch";
import { currentTelemetry } from "../telemetry";
import { docsBlocks, docsSnapshot } from "../testFixtures";
import type { Snapshot } from "../types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, "../../..");
const EXAMPLES = path.join(PACKAGE, "conformance/observability");

const ENDPOINT = "https://otel.example.com";
const OTHER_ENDPOINT = "https://otel.other.example";
const HOSTED_TELEMETRY_ENDPOINT = "https://otel.decocms.com";
const BACKGROUND_HOOK = Symbol.for("decocms.blocks.background");

let tasks: (() => Promise<void>)[] = [];
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
  resetForTests();
});

/** Runs queued background work as the next responses would, each pass one batch window later. */
async function runBackground(): Promise<void> {
  for (let i = 0; i < 10 && tasks.length > 0; i++) {
    clock += 10_000;
    await Promise.all(tasks.splice(0).map((task) => task()));
  }
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  raw: Buffer;
  text: string;
  body: any;
}

/**
 * Stubs global fetch: requests to a collector (`/v1/...`) are recorded and
 * answered with `statuses` in order; anything else answers 200 `{}`.
 */
function collector(statuses: number[] = []) {
  const sent: Sent[] = [];
  const attempts: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!/\/v1\/(metrics|logs|traces)$/.test(url)) return new Response("{}", { status: 200 });
    attempts.push(url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = Buffer.from(init?.body as Uint8Array);
    const text = headers["content-encoding"] === "gzip" ? gunzipSync(raw).toString() : String(raw);
    sent.push({ url, headers, raw, text, body: JSON.parse(text) });
    return new Response(null, { status: statuses.shift() ?? 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return { sent, attempts, fetch };
}

function attrs(list: { key: string; value: Record<string, unknown> }[] = []) {
  return Object.fromEntries(list.map(({ key, value }) => [key, Object.values(value)[0]]));
}

function metrics(sent: Sent[]) {
  return sent
    .filter((s) => s.url.endsWith("/v1/metrics"))
    .flatMap((s) => s.body.resourceMetrics[0].scopeMetrics[0].metrics);
}

function logRecords(sent: Sent[]) {
  return sent
    .filter((s) => s.url.endsWith("/v1/logs"))
    .flatMap((s) => s.body.resourceLogs[0].scopeLogs[0].logRecords);
}

function spans(sent: Sent[]) {
  return sent
    .filter((s) => s.url.endsWith("/v1/traces"))
    .flatMap((s) => s.body.resourceSpans[0].scopeSpans[0].spans);
}

function withTelemetryBlock(block: Record<string, unknown>, revision = "rev-1"): Snapshot {
  const snapshot = docsSnapshot(revision);
  return {
    ...snapshot,
    blocks: { ...snapshot.blocks, CMS: { __resolveType: "cms-settings", telemetry: block } },
  };
}

/** An upstream API answering with `status` (default 200). */
function upstreamWith(statuses: (number | "throw")[] = [], provider = "acme-search") {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = statuses.shift() ?? 200;
    if (next === "throw") throw new TypeError("network down");
    return new Response("{}", { status: next });
  });
  return { calls, fetch, request: createInstrumentedFetch({ provider, fetch }) };
}

const broken = () => {
  throw new Error(
    "upstream said no: authorization: Bearer sk_live_123 at https://api.example/x?token=abc&q=1 " +
      'cookie=session=s3cr3t; token: "xyz" password=hunter2 (Bearer abc.def)',
  );
};

// ---------------------------------------------------------------------------
// The docs' snippets, typechecked as written
// ---------------------------------------------------------------------------

describe("the docs' snippets typecheck (conformance/observability)", () => {
  let diagnostics = "";
  beforeAll(() => {
    try {
      execFileSync(
        process.execPath,
        [
          path.join(PACKAGE, "../../node_modules/typescript/bin/tsc"),
          "-p",
          path.join(EXAMPLES, "tsconfig.json"),
        ],
        { encoding: "utf8", cwd: PACKAGE },
      );
    } catch (error) {
      diagnostics = String((error as { stdout?: string }).stdout ?? error);
    }
  }, 120_000);

  const errorsIn = (file: string) =>
    diagnostics
      .split("\n")
      .filter((line) => line.includes(`observability/${file}(`))
      .join("\n");

  it("tel-01/tel-02: cms.ts with telemetry { endpoint, headers } compiles, headers optional", () => {
    expect(errorsIn("cms.ts")).toBe("");
  });
  it("tel-03: a top-level site and token, and telemetry: false, are accepted (cms.ts)", () => {
    expect(fs.readFileSync(path.join(EXAMPLES, "cms.ts"), "utf8")).toContain(
      "createCMS({ blocks, content, site, token })",
    );
    expect(errorsIn("cms.ts")).toBe("");
  });
  it("tel-25/tel-24: the Sampling snippet (limits) compiles inside createCMS", () => {
    expect(errorsIn("cms.ts")).toBe("");
  });
  it("tel-29: the traced() block map compiles with `satisfies Blocks`", () => {
    expect(errorsIn(".deco/index.ts")).toBe("");
  });
  it("tel-33: telemetry.resource (the app's own commit and environment) compiles (cms.ts)", () => {
    expect(fs.readFileSync(path.join(EXAMPLES, "cms.ts"), "utf8")).toContain("resource: {");
    expect(errorsIn("cms.ts")).toBe("");
  });
  it("htel-01: the hosted-telemetry cms.ts compiles with site/token possibly undefined", () => {
    expect(errorsIn("hosted-cms.ts")).toBe("");
  });
  it("ana-04: the analytics layout (`const { analytics } = await cms.settings()`, `<AnalyticsScript {...analytics} />`) compiles", () => {
    expect(errorsIn("layout.tsx")).toBe("");
  });
  it("ana-08: the track() button compiles", () => {
    expect(errorsIn("track-button.tsx")).toBe("");
  });
  it("up-10/up-11/up-12: acme-search.ts, src/search.ts and the product-shelf block compile", () => {
    expect(errorsIn("acme-search.ts")).toBe("");
    expect(errorsIn("search.ts")).toBe("");
    expect(errorsIn("shelf-blocks.tsx")).toBe("");
  });
  it("nothing else in the fixture fails to typecheck", () => {
    const unexpected = diagnostics.split("\n").filter((line) => /error TS/.test(line));
    expect(unexpected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// telemetry.mdx › Choose where telemetry goes
// ---------------------------------------------------------------------------

describe("where telemetry goes (telemetry.mdx)", () => {
  it("tel-01: telemetry { endpoint, headers } POSTs OTLP to endpoint + /v1/metrics with the headers", async () => {
    const { sent } = collector();
    createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      telemetry: { endpoint: ENDPOINT, headers: { authorization: "Bearer otlp-token" } },
    });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(sent.map((s) => s.url)).toEqual([`${ENDPOINT}/v1/metrics`]);
    expect(sent[0]?.headers.authorization).toBe("Bearer otlp-token");
  });

  it("tel-02: headers is optional", async () => {
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.authorization).toBeUndefined();
  });

  it("tel-03/htel-02: a top-level token sends to the hosted collector with token auth, and site to deco.site", async () => {
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: "acme", token: "site-token" });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(sent[0]?.url).toBe(`${HOSTED_TELEMETRY_ENDPOINT}/v1/metrics`);
    expect(sent[0]?.headers.authorization).toBe("Bearer site-token");
    expect(attrs(sent[0]?.body.resourceMetrics[0].resource.attributes)["deco.site"]).toBe("acme");
  });

  it("tel-04: telemetry: false sends nothing, even with a token", async () => {
    const { fetch } = collector();
    createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: "acme",
      token: "tok",
      telemetry: false,
    });
    expect(currentTelemetry()).toBeUndefined();
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tel-05: an endpoint wins over the token; no environment variable is read (OTEL_*, DECO_OTEL_*)", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://env.example.com");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer%20env-token");
    vi.stubEnv("DECO_OTEL_AUTH_TOKEN", "Bearer v7");
    const { sent } = collector();
    createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: "acme",
      token: "tok",
      telemetry: { endpoint: ENDPOINT, headers: { "x-team": "store" } },
    });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(sent.map((s) => s.url)).toEqual([`${ENDPOINT}/v1/metrics`]);
    expect(sent[0]?.headers["x-team"]).toBe("store");
    expect(sent[0]?.headers.authorization).toBeUndefined();
  });

  it("tel-06: without an endpoint or a token, nothing is sent (environment variables set or not)", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", ENDPOINT);
    const { fetch } = collector();
    const cms = createCMS({ blocks: { ...docsBlocks(), broken }, content: docsSnapshot() });
    await cms.forRelease().resolve({ __resolveType: "broken" });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tel-07: a top-level site alone never turns telemetry on", async () => {
    const { attempts } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: "acme" });
    expect(currentTelemetry()).toBeUndefined();
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(attempts).toEqual([]);
  });

  it("tel-30: client.revision() returns the served revision", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot("rev-served") });
    await expect(cms.forRelease().revision()).resolves.toBe("rev-served");
  });
});

// ---------------------------------------------------------------------------
// telemetry.mdx › What's sent
// ---------------------------------------------------------------------------

describe("what's sent (telemetry.mdx)", () => {
  it("tel-08/up-14: http.client.request.duration with provider, operation, status_class (2xx/4xx/5xx/error), cached, retries", async () => {
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    const { request } = upstreamWith([200, 404, 503, "throw"]);
    await request("https://search.example/a", { operation: "search" });
    await request("https://search.example/b", { operation: "search" });
    await request("https://search.example/c", { operation: "search" });
    await expect(request("https://search.example/d", { operation: "search" })).rejects.toThrow();
    await runBackground();
    const metric = metrics(sent).find((m) => m.name === "http.client.request.duration");
    expect(metric).toBeDefined();
    const points = metric.histogram.dataPoints.map((p: any) => attrs(p.attributes));
    expect(points.map((p: any) => p.status_class).sort()).toEqual(["2xx", "4xx", "5xx", "error"]);
    for (const p of points) {
      expect(Object.keys(p).sort()).toEqual(
        ["cached", "operation", "provider", "retries", "status_class"].sort(),
      );
      expect(p).toMatchObject({ provider: "acme-search", operation: "search", cached: false });
    }
  });

  it("tel-08: the duration is timed until response headers arrive, not until the body is read", async () => {
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    let release!: () => void;
    const slowBody = new ReadableStream({
      start(controller) {
        release = () => {
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        };
      },
    });
    const request = createInstrumentedFetch({
      provider: "acme-search",
      fetch: async () => new Response(slowBody, { status: 200 }),
    });
    const response = await request("https://search.example/q", { operation: "search" });
    // The body arrives 300 ms after the headers; the measurement must not include it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await response.text();
    await runBackground();
    const point = metrics(sent)[0]?.histogram.dataPoints[0];
    expect(point.count).toBe("1");
    expect(point.sum).toBeLessThan(0.2);
  });

  it("tel-13: an app using only @decocms/blocks sends upstream latency and error logs", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    const { request } = upstreamWith(["throw"]);
    await expect(request("https://search.example/q", { operation: "search" })).rejects.toThrow();
    await runBackground();
    expect(metrics(sent).map((m) => m.name)).toContain("http.client.request.duration");
    const [record] = logRecords(sent);
    expect(attrs(record.attributes)).toMatchObject({
      "error.code": "FETCH_FAILED",
      provider: "acme-search",
    });
  });

  it("tel-14: a retried request counts once, with retries as a label", async () => {
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    const responses = [503, 503, 200];
    const upstream = vi.fn(async () => new Response("{}", { status: responses.shift() ?? 200 }));
    const request = createInstrumentedFetch({
      provider: "acme-search",
      fetch: upstream,
      retry: { attempts: 2, backoffMs: 1 },
    });
    const response = await request("https://search.example/q", { operation: "search" });
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(3);
    await runBackground();
    const points = metrics(sent)[0].histogram.dataPoints;
    expect(points).toHaveLength(1);
    expect(points[0].count).toBe("1");
    expect(attrs(points[0].attributes)).toMatchObject({ retries: "2", status_class: "2xx" });
  });

  it("tel-11/tel-28: error logs go to /v1/logs, structured with code, message and where (block type), at errorSampleRate", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: withTelemetryBlock({ errorSampleRate: 1 }),
      telemetry: { endpoint: ENDPOINT, limits: { errorSampleRate: 1 } },
    });
    const [, error] = await cms.forRelease().resolve({ __resolveType: "broken" });
    expect(error?.code).toBe("BLOCK_FAILED");
    await runBackground();
    const [record] = logRecords(sent);
    expect(record).toBeDefined();
    expect(record.severityText).toBe("ERROR");
    expect(record.body.stringValue).toContain("upstream said no");
    expect(attrs(record.attributes)).toMatchObject({
      "error.code": "BLOCK_FAILED",
      "deco.block.type": "broken",
    });
  });

  it("tel-12: traces are off by default", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      telemetry: { endpoint: ENDPOINT },
    });
    await cms.forRelease().resolve("SummerPage");
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(sent.some((s) => s.url.endsWith("/v1/traces"))).toBe(false);
  });

  // The first client of a release must already honour that release's telemetry
  // section: no warm-up request before the one that should be traced.
  it("tel-12: with limits and block traceSampleRate 1, block resolution and upstream spans are sent", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withTelemetryBlock({ traceSampleRate: 1 }),
      telemetry: { endpoint: ENDPOINT, limits: { traceSampleRate: 1 } },
    });
    await cms.forRelease().resolve("SummerPage");
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    const names = spans(sent).map((s: any) => s.name);
    expect(names).toContain("hero");
    expect(names).toContain("acme-search search");
  });

  it("tel-22: metrics are aggregated: 100 identical calls make one histogram point with count 100", async () => {
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    const { request } = upstreamWith();
    for (let i = 0; i < 100; i++)
      await request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(sent).toHaveLength(1);
    const points = metrics(sent)[0].histogram.dataPoints;
    expect(points).toHaveLength(1);
    expect(points[0].count).toBe("100");
    const buckets = points[0].bucketCounts.map(Number);
    expect(buckets.reduce((a: number, b: number) => a + b, 0)).toBe(100);
    expect(points[0].bucketCounts.length).toBe(points[0].explicitBounds.length + 1);
  });

  it("tel-31: plain fetch (not createInstrumentedFetch) is not measured", async () => {
    const { attempts } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await globalThis.fetch("https://search.example/q");
    await runBackground();
    expect(attempts).toEqual([]);
  });

  it("tel-32/tin-04: delta temporality: a second batch carries only what happened since the first", async () => {
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    const { request } = upstreamWith();
    await request("https://search.example/q", { operation: "search" });
    await request("https://search.example/q", { operation: "search" });
    await runBackground();
    await request("https://search.example/q", { operation: "search" });
    await runBackground();
    const all = metrics(sent);
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.histogram.aggregationTemporality)).toEqual([1, 1]);
    expect(all.map((m) => m.histogram.dataPoints[0].count)).toEqual(["2", "1"]);
  });

  it("up-13: with telemetry off, the instrumented fetch still works and nothing reaches a collector", async () => {
    const { attempts } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: false });
    const { request, calls } = upstreamWith([200]);
    const response = await request("https://search.example/q", { operation: "search" });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["https://search.example/q"]);
    await runBackground();
    expect(attempts).toEqual([]);
  });

  it("up-09: createInstrumentedFetch({ provider, fetch: undefined }) returns (url, { operation, ...init }) => Promise<Response>", async () => {
    const upstream = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", upstream);
    const request = createInstrumentedFetch({ provider: "acme-search", fetch: undefined });
    const response = await request(new URL("https://search.example/v1/search?q=x"), {
      operation: "search",
      headers: { authorization: "Bearer k" },
    });
    expect(response).toBeInstanceOf(Response);
    expect(upstream).toHaveBeenCalledTimes(1);
    const init = upstream.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(init[1]).not.toHaveProperty("operation");
  });
});

// ---------------------------------------------------------------------------
// telemetry.mdx › Telemetry settings are content
// ---------------------------------------------------------------------------

describe("the telemetry section of the CMS block (telemetry.mdx)", () => {
  it("tel-16/tel-21/ana-02: `cms-settings` is always in the schema, its telemetry section with enabled, metrics, errorSampleRate, traceSampleRate and no destination fields", async () => {
    const fixture = createFixture({
      ".deco/index.ts": "export default {};\n",
    });
    try {
      const { meta } = await generateSchema(decoPaths(fixture.root));
      expect(meta.manifest.blocks.content["cms-settings"]).toBeDefined();
      const settings = meta.schema.definitions[toBase64("cms-settings")] as any;
      expect(Object.keys(settings.properties).sort()).toEqual(
        ["__resolveType", "analytics", "preview", "telemetry"].sort(),
      );
      const definition = settings.properties.telemetry;
      const props = definition.properties ?? definition;
      const fields = Object.keys(
        JSON.stringify(definition).includes("errorSampleRate") ? props : {},
      );
      expect(JSON.stringify(definition)).toContain('"enabled"');
      expect(JSON.stringify(definition)).toContain('"metrics"');
      expect(JSON.stringify(definition)).toContain('"errorSampleRate"');
      expect(JSON.stringify(definition)).toContain('"traceSampleRate"');
      for (const forbidden of ["endpoint", "headers", "token", "site"]) {
        expect(JSON.stringify(definition)).not.toContain(`"${forbidden}"`);
      }
      expect(fields).not.toContain("endpoint");
      // ana-02: the analytics section has collector and enabled only (no site ID).
      const analytics = settings.properties.analytics;
      expect(Object.keys(analytics.properties ?? {}).sort()).toEqual(["collector", "enabled"]);
      // The old built-ins are gone, with no alias.
      expect(meta.schema.definitions[toBase64("telemetry")]).toBeUndefined();
      expect(meta.schema.definitions[toBase64("analytics")]).toBeUndefined();
    } finally {
      fixture.remove();
    }
  }, 60_000);

  it("tel-17: defaults apply with no CMS block: enabled, metrics on, errorSampleRate 0.05, traces off", async () => {
    const { sent } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: docsSnapshot(),
      telemetry: { endpoint: ENDPOINT, limits: { errorSampleRate: 1, traceSampleRate: 1 } },
    });
    const random = vi.spyOn(Math, "random");
    random.mockReturnValue(0.049); // < 0.05: an error is kept; >= 0 trace rate: no trace
    await cms.forRelease().resolve({ __resolveType: "broken" });
    random.mockReturnValue(0.051); // >= 0.05: dropped
    await cms.forRelease().resolve({ __resolveType: "broken" });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(logRecords(sent)).toHaveLength(1);
    expect(metrics(sent)).toHaveLength(1);
    expect(spans(sent)).toHaveLength(0);
  });

  it("tel-17: {__resolveType: 'cms-settings'} returns its input with the telemetry defaults filled in (built-in-blocks)", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const [value] = await cms.forRelease().resolve<{ telemetry: unknown }>({
      __resolveType: "cms-settings",
      telemetry: { metrics: false },
    });
    expect(value?.telemetry).toEqual({
      enabled: true,
      metrics: false,
      errorSampleRate: 0.05,
      traceSampleRate: 0,
    });
  });

  it("tel-18: enabled: false switches all telemetry off", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { attempts } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: withTelemetryBlock({ enabled: false, errorSampleRate: 1, traceSampleRate: 1 }),
      telemetry: { endpoint: ENDPOINT, limits: { errorSampleRate: 1, traceSampleRate: 1 } },
    });
    await cms.forRelease().resolve({ __resolveType: "broken" });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(attempts).toEqual([]);
  });

  it("tel-19: metrics: false stops metrics, but error logs are still sent", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: withTelemetryBlock({ metrics: false }),
      telemetry: { endpoint: ENDPOINT },
    });
    await cms.forRelease().resolve({ __resolveType: "broken" });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(sent.some((s) => s.url.endsWith("/v1/metrics"))).toBe(false);
    expect(sent.some((s) => s.url.endsWith("/v1/logs"))).toBe(true);
  });

  it("tel-20: deco content doesn't create .deco/blocks/CMS.json", () => {
    const fixture = createFixture({
      ".deco/index.ts": "export default {};\n",
      ".deco/blocks/Home.json": { __resolveType: "page", name: "Home", path: "/", sections: [] },
    });
    try {
      execFileSync(process.execPath, [path.join(PACKAGE, "bin/deco.js"), "content"], {
        cwd: fixture.root,
        encoding: "utf8",
        stdio: "pipe",
      });
      expect(fixture.exists(".deco/blocks.gen.ts")).toBe(true);
      expect(fixture.exists(".deco/blocks/CMS.json")).toBe(false);
    } finally {
      fixture.remove();
    }
  }, 60_000);

  it("tel-21: the telemetry section can't redirect telemetry (an endpoint field is ignored)", async () => {
    const { sent } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withTelemetryBlock({ endpoint: "https://evil.example", headers: { x: "y" } }),
      telemetry: { endpoint: ENDPOINT },
    });
    await cms.forRelease().revision();
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(sent.map((s) => s.url)).toEqual([`${ENDPOINT}/v1/metrics`]);
  });
});

// ---------------------------------------------------------------------------
// telemetry.mdx › Sampling
// ---------------------------------------------------------------------------

describe("sampling and limits (telemetry.mdx)", () => {
  async function errorsKept(
    block: Record<string, unknown>,
    limits: Record<string, number> | undefined,
    random: number,
  ): Promise<number> {
    resetForTests();
    tasks = [];
    const { sent } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: withTelemetryBlock(block),
      telemetry: { endpoint: ENDPOINT, ...(limits ? { limits } : {}) },
    });
    vi.spyOn(Math, "random").mockReturnValue(random);
    await cms.forRelease().resolve({ __resolveType: "broken" });
    await runBackground();
    return logRecords(sent).length;
  }

  it("tel-24: without limits, a block errorSampleRate of 1 is capped at 0.1", async () => {
    expect(await errorsKept({ errorSampleRate: 1 }, undefined, 0.09)).toBe(1);
    expect(await errorsKept({ errorSampleRate: 1 }, undefined, 0.11)).toBe(0);
  });

  it("tel-24: without limits, a block traceSampleRate of 1 stays at 0 (traces off)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withTelemetryBlock({ traceSampleRate: 1 }),
      telemetry: { endpoint: ENDPOINT },
    });
    await cms.forRelease().resolve("SummerPage");
    await runBackground();
    expect(spans(sent)).toHaveLength(0);
  });

  it("tel-24: the effective rate is min(block, limit)", async () => {
    expect(await errorsKept({ errorSampleRate: 0.3 }, { errorSampleRate: 0.5 }, 0.29)).toBe(1);
    expect(await errorsKept({ errorSampleRate: 0.3 }, { errorSampleRate: 0.5 }, 0.31)).toBe(0);
    expect(await errorsKept({ errorSampleRate: 1 }, { errorSampleRate: 0.5 }, 0.49)).toBe(1);
    expect(await errorsKept({ errorSampleRate: 1 }, { errorSampleRate: 0.5 }, 0.51)).toBe(0);
  });

  it("tel-23: sending never delays a response; a collector that hangs only holds its own batch", async () => {
    const hanging = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", hanging);
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    const { request } = upstreamWith();
    const response = await request("https://search.example/q", { operation: "search" });
    expect(response.status).toBe(200); // the request finished; nothing was sent in front of it
    expect(hanging).not.toHaveBeenCalled();
    clock += 10_000;
    // The batch goes out in the background; nobody awaits it.
    for (const task of tasks.splice(0)) void task();
    await new Promise((r) => setTimeout(r, 10));
    expect(hanging).toHaveBeenCalledTimes(1);
    const second = await request("https://search.example/q", { operation: "search" });
    expect(second.status).toBe(200);
  });

  it("tel-23/tin-07: a collector that's down loses only that batch; the next carries only new data", async () => {
    let down = true;
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes("/v1/")) return new Response("{}");
        if (down) throw new TypeError("connection refused");
        const raw = Buffer.from(init?.body as Uint8Array);
        bodies.push(JSON.parse(gunzipSync(raw).toString()));
        return new Response(null, { status: 200 });
      }),
    );
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    const { request } = upstreamWith();
    for (let i = 0; i < 5; i++) await request("https://search.example/q", { operation: "search" });
    await runBackground();
    down = false;
    await request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(bodies).toHaveLength(1);
    expect(
      bodies[0].resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0].count,
    ).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// telemetry.mdx › Privacy, telemetry-internals.mdx › Scrubbing
// ---------------------------------------------------------------------------

describe("privacy (telemetry.mdx, telemetry-internals.mdx)", () => {
  it("tel-26/tin-08: no tokens, cookies, authorization values or query strings leave the SDK", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: withTelemetryBlock({ errorSampleRate: 1 }),
      telemetry: { endpoint: ENDPOINT, limits: { errorSampleRate: 1 } },
    });
    await cms.forRelease().resolve({ __resolveType: "broken" });
    const failing = createInstrumentedFetch({
      provider: "acme-search",
      fetch: async () => {
        throw new Error("failed GET https://api.example/s?apiKey=k123 with cookie: sid=c00kie");
      },
    });
    await expect(
      failing("https://api.example/s?apiKey=k123", {
        operation: "search",
        headers: { authorization: "Bearer hdr-secret", cookie: "sid=c00kie" },
        body: "request-body-secret",
        method: "POST",
      }),
    ).rejects.toThrow();
    await runBackground();
    const everything = sent.map((s) => s.text).join("\n");
    expect(everything).toContain("upstream said no");
    for (const secret of [
      "sk_live_123",
      "s3cr3t",
      "xyz",
      "hunter2",
      "abc.def",
      "token=abc",
      "k123",
      "c00kie",
      "hdr-secret",
      "request-body-secret",
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// telemetry.mdx › Your own tracing
// ---------------------------------------------------------------------------

describe("your own tracing (telemetry.mdx)", () => {
  it("tel-29: a traced() block keeps its props schema and its Promise result is awaited", async () => {
    const banner = fs.readFileSync(path.join(EXAMPLES, "promo-banner.tsx"), "utf8");
    const traced = fs
      .readFileSync(path.join(EXAMPLES, ".deco/index.ts"), "utf8")
      .replace('"../promo-banner"', '"../src/promo-banner"');
    const plain = `import type { Blocks } from "@decocms/blocks";
import { PromoBanner } from "../src/promo-banner";
export default { "promo-banner": PromoBanner } satisfies Blocks;
`;
    const schemaOf = async (index: string) => {
      const fixture = createFixture({ "src/promo-banner.tsx": banner, ".deco/index.ts": index });
      try {
        const { meta } = await generateSchema(decoPaths(fixture.root));
        return JSON.stringify(
          Object.fromEntries(
            Object.entries(meta.schema.definitions).filter(
              ([key]) => key.startsWith(toBase64("promo-banner")) || key.includes("@"),
            ),
          ),
        );
      } finally {
        fixture.remove();
      }
    };
    const [withSpan, without] = await Promise.all([schemaOf(traced), schemaOf(plain)]);
    expect(withSpan).toContain("title");
    expect(withSpan).toContain("href");
    expect(withSpan).toBe(without);

    // At runtime the wrapped block's Promise is awaited like any other result.
    const cms = createCMS({
      blocks: {
        "promo-banner": (props: { title: string }) =>
          Promise.resolve({ component: "promo-banner", props }),
      },
      content: docsSnapshot(),
    });
    const [value] = await cms
      .forRelease()
      .resolve({ __resolveType: "promo-banner", title: "Sale" });
    expect(value).toEqual({ component: "promo-banner", props: { title: "Sale" } });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// telemetry-internals.mdx
// ---------------------------------------------------------------------------

describe("how telemetry is sent (telemetry-internals.mdx)", () => {
  it("tin-01: OTLP/HTTP JSON to {endpoint}/v1/metrics, /v1/logs and /v1/traces; no protobuf dependency", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: withTelemetryBlock({ errorSampleRate: 1, traceSampleRate: 1 }),
      telemetry: { endpoint: ENDPOINT, limits: { errorSampleRate: 1, traceSampleRate: 1 } },
    });
    await cms.forRelease().resolve({ __resolveType: "broken" });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(sent.map((s) => s.url).sort()).toEqual(
      [`${ENDPOINT}/v1/logs`, `${ENDPOINT}/v1/metrics`, `${ENDPOINT}/v1/traces`].sort(),
    );
    for (const s of sent) expect(s.headers["content-type"]).toBe("application/json");
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
    expect(deps.filter((d) => /protobuf|otlp-proto|@opentelemetry\/exporter/.test(d))).toEqual([]);
  });

  it("tin-02: bodies are gzipped", async () => {
    const { sent } = collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(sent[0]?.headers["content-encoding"]).toBe("gzip");
    expect(sent[0]?.raw[0]).toBe(0x1f);
    expect(sent[0]?.raw[1]).toBe(0x8b);
    expect(sent[0]?.body.resourceMetrics).toBeDefined();
  });

  it("tin-03: a failed send is retried only on 429, 502, 503 and 504", async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) =>
      realSetTimeout(fn, 0)) as typeof setTimeout);
    for (const [status, expected] of [
      [429, 2],
      [502, 2],
      [503, 2],
      [504, 2],
      [500, 1],
      [400, 1],
    ] as const) {
      resetForTests();
      tasks = [];
      const { attempts } = collector([status, status]);
      createCMS({
        blocks: docsBlocks(),
        content: docsSnapshot(),
        telemetry: { endpoint: ENDPOINT },
      });
      await upstreamWith().request("https://search.example/q", { operation: "search" });
      await runBackground();
      expect([status, attempts.length]).toEqual([status, expected]);
    }
  });

  it("tin-03: a network error drops the batch (one attempt)", async () => {
    const collectorFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/v1/")) throw new TypeError("network down");
      return new Response("{}");
    });
    vi.stubGlobal("fetch", collectorFetch);
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(collectorFetch).toHaveBeenCalledTimes(1);
  });

  it("tin-05: every batch carries service.name, service.version, deployment.environment.name, deco.site and deco.release", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sent } = collector();
    const cms = createCMS({
      blocks: { ...docsBlocks(), broken },
      content: withTelemetryBlock({ errorSampleRate: 1, traceSampleRate: 1 }, "rev-9"),
      site: "acme",
      token: "tok",
      telemetry: { limits: { errorSampleRate: 1, traceSampleRate: 1 } },
    });
    await cms.forRelease().resolve({ __resolveType: "broken" });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    expect(sent).toHaveLength(3);
    for (const s of sent) {
      const resource = attrs(
        (s.body.resourceMetrics ?? s.body.resourceLogs ?? s.body.resourceSpans)[0].resource
          .attributes,
      );
      expect(Object.keys(resource)).toEqual(
        expect.arrayContaining([
          "service.name",
          "service.version",
          "deployment.environment.name",
          "deco.site",
          "deco.release",
        ]),
      );
      expect(resource["deco.site"]).toBe("acme");
      expect(resource["deco.release"]).toBe("rev-9");
    }
  });

  it("tin-05: deco.site is absent when there's no site", async () => {
    const { sent } = collector();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      telemetry: { endpoint: ENDPOINT },
    });
    await cms.forRelease().revision();
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    await runBackground();
    const resource = attrs(sent[0]?.body.resourceMetrics[0].resource.attributes);
    expect(resource).not.toHaveProperty("deco.site");
    expect(resource["deco.release"]).toBe("rev-1");
  });

  it("tin-06: without a binding's hook, batches go out on a timer that doesn't keep the process alive", async () => {
    delete (globalThis as Record<symbol, unknown>)[BACKGROUND_HOOK];
    const timers: { hasRef(): boolean; delay: number }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay?: number) => {
      const timer = realSetTimeout(fn, delay) as unknown as NodeJS.Timeout;
      timers.push(Object.assign(timer, { delay: delay ?? 0 }) as never);
      return timer;
    }) as typeof setTimeout);
    collector();
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), telemetry: { endpoint: ENDPOINT } });
    await upstreamWith().request("https://search.example/q", { operation: "search" });
    const flushTimer = timers.find((t) => t.delay >= 1_000);
    expect(flushTimer).toBeDefined();
    expect(flushTimer?.hasRef()).toBe(false);
    clearTimeout(flushTimer as never);
  });

  it("tin-09: the instrumented fetch reports to the most recently created CMS with telemetry; several sites in one process share one destination", async () => {
    const { sent } = collector();
    const search = upstreamWith();
    const shelf = async () => {
      await search.request("https://search.example/q", { operation: "search" });
      return "shelf";
    };
    const siteA = createCMS({
      blocks: { shelf },
      content: { revision: "a", root: "site-a/.deco", blocks: {} },
      telemetry: { endpoint: ENDPOINT },
    });
    const siteB = createCMS({
      blocks: { shelf },
      content: { revision: "b", root: "site-b/.deco", blocks: {} },
      telemetry: { endpoint: OTHER_ENDPOINT },
    });
    // siteB was created last: both sites' measurements go to its destination.
    await siteA.forRelease().resolve({ __resolveType: "shelf" });
    await runBackground();
    expect(sent.map((s) => s.url)).toEqual([`${OTHER_ENDPOINT}/v1/metrics`]);
    sent.length = 0;
    await siteB.forRelease().resolve({ __resolveType: "shelf" });
    await runBackground();
    expect(sent.map((s) => s.url)).toEqual([`${OTHER_ENDPOINT}/v1/metrics`]);
  });
});

// ---------------------------------------------------------------------------
// caching.mdx (the core half)
// ---------------------------------------------------------------------------

describe("caching (caching.mdx)", () => {
  it("cache-01: the content map is held once per process even if the package is loaded twice", async () => {
    vi.resetModules();
    const a = await import("../index");
    vi.resetModules();
    const b = await import("../index");
    expect(a.createCMS).not.toBe(b.createCMS);
    const load = vi.fn(async () => docsSnapshot());
    const loader = { load, update: async () => ({ updated: false }) };
    const cmsA = a.createCMS({ blocks: docsBlocks(), content: loader });
    const cmsB = b.createCMS({ blocks: docsBlocks(), content: loader });
    expect(instanceOf(cmsB)).toBe(instanceOf(cmsA));
    await cmsA.forRelease().resolve("SummerSEO");
    await cmsB.forRelease().resolve("SummerSEO");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("cache-02: a client runs each block once per request; a new client runs it again", async () => {
    const product = vi.fn(({ slug }: { slug: string }) => ({ slug }));
    const cms = createCMS({
      blocks: { ...docsBlocks(), "catalog-product": product },
      content: docsSnapshot(),
    });
    const client = cms.forRelease();
    await client.resolve("CurrentProduct");
    await client.resolve("CurrentProduct");
    await client.resolve("SummerCard");
    expect(product).toHaveBeenCalledTimes(1);
    await cms.forRelease().resolve("CurrentProduct");
    expect(product).toHaveBeenCalledTimes(2);
  });

  it("cache-07: a date matcher is evaluated when a page is resolved, per client", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: {
        revision: "rev-dates",
        blocks: {
          Banner: {
            __resolveType: "multivariate",
            variants: [
              {
                rule: { __resolveType: "date", start: "2030-01-01T00:00:00Z" },
                value: { __resolveType: "lazy", value: "campaign" },
              },
              {
                rule: { __resolveType: "always" },
                value: { __resolveType: "lazy", value: "default" },
              },
            ],
          },
        },
      },
    });
    clock = Date.parse("2029-12-31T23:59:00Z") - (Date.now() - clock);
    expect((await cms.forRelease().resolve("Banner"))[0]).toBe("default");
    clock += 2 * 60_000;
    expect((await cms.forRelease().resolve("Banner"))[0]).toBe("campaign");
  });
});
