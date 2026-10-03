// @vitest-environment node
/**
 * Conformance: the framework-binding half of telemetry.mdx ("What's sent"),
 * telemetry-internals.mdx ("Sending in the background") and caching.mdx
 * ("Upstream data"), for `@decocms/tanstack` on Cloudflare Workers.
 *
 * A site on Workers creates its CMS with `createCMS({ telemetry })` from
 * `@decocms/blocks` and serves through the binding's worker entry. The docs
 * say the binding then adds inbound request and edge-cache metrics to that
 * CMS's telemetry, sends batches inside `ctx.waitUntil`, and caches upstream
 * responses (made through `createInstrumentedFetch`) with the Cache API,
 * except while a draft is being rendered.
 */
import { gunzipSync } from "node:zlib";
import { createCMS, DRAFT_COOKIE, resetForTests } from "@decocms/blocks";
import { setBlocks } from "@decocms/blocks/cms";
import { createInstrumentedFetch } from "@decocms/blocks/fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecoWorkerEntry } from "../sdk/workerEntry";

const ENDPOINT = "https://otel.example.com";

let clock = 0;
let waits: Promise<unknown>[] = [];
const ctx = {
  waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
  passThroughOnException: () => {},
};

interface Sent {
  url: string;
  text: string;
  body: any;
}

let sent: Sent[] = [];
let upstreamCalls: string[] = [];

beforeEach(() => {
  resetForTests();
  // The only worker entry @decocms/tanstack has is v7's, which needs v7's block
  // registry loaded even for an app that only uses createCMS.
  setBlocks({});
  clock = 0;
  waits = [];
  sent = [];
  upstreamCalls = [];
  const now = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => now() + clock);
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(ENDPOINT)) {
        const raw = Buffer.from(init?.body as Uint8Array);
        const gz = new Headers(init?.headers).get("content-encoding") === "gzip";
        const text = gz ? gunzipSync(raw).toString() : String(raw);
        sent.push({ url, text, body: JSON.parse(text) });
        return new Response(null, { status: 200 });
      }
      upstreamCalls.push(url);
      return new Response(JSON.stringify({ hits: [] }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "max-age=60" },
      });
    }),
  );
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("decocms.blocks.background")];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetForTests();
});

/** A Cache API stand-in (`caches.default`) that remembers what was put. */
function fakeCaches() {
  const store = new Map<string, Response>();
  const puts: string[] = [];
  const cache = {
    match: vi.fn(async (request: Request | string) => {
      const key = typeof request === "string" ? request : request.url;
      return store.get(key)?.clone();
    }),
    put: vi.fn(async (request: Request | string, response: Response) => {
      const key = typeof request === "string" ? request : request.url;
      puts.push(key);
      store.set(key, response.clone());
    }),
    delete: vi.fn(async () => true),
  };
  vi.stubGlobal("caches", { default: cache, open: async () => cache });
  return { cache, puts };
}

/** Lets every queued background task run, one batch window (10 s) after the last. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    clock += 10_000;
    const pending = waits.splice(0);
    if (pending.length === 0) break;
    await Promise.all(pending);
  }
}

function metrics() {
  return sent
    .filter((s) => s.url.endsWith("/v1/metrics"))
    .flatMap((s) => s.body.resourceMetrics[0].scopeMetrics[0].metrics);
}

function attrs(list: { key: string; value: Record<string, unknown> }[] = []) {
  return Object.fromEntries(list.map(({ key, value }) => [key, Object.values(value)[0]]));
}

const search = createInstrumentedFetch({ provider: "acme-search" });

/** The app's server entry: a product page that calls an upstream API through the instrumented fetch. */
const serverEntry = {
  fetch: async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/products/")) {
      await search("https://search.example/v1/search?q=shirt", { operation: "search" });
      return new Response("<html>product</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("not found", { status: 404 });
  },
};

function cms() {
  return createCMS({
    blocks: {},
    content: { revision: "rev-1", root: "tanstack-conformance/.deco", blocks: {} },
    telemetry: { endpoint: ENDPOINT },
  });
}

async function serve(worker: ReturnType<typeof createDecoWorkerEntry>, path: string, headers = {}) {
  const response = await worker.fetch(new Request(`https://shop.example${path}`, { headers }), {}, ctx);
  await response.text();
  return response;
}

describe("sending in the background (telemetry-internals.mdx)", () => {
  it("tin-06: on Workers, batches go out after the response, inside ctx.waitUntil", async () => {
    cms();
    const worker = createDecoWorkerEntry(serverEntry, { observability: false });
    await serve(worker, "/products/abc-123");
    expect(sent).toEqual([]); // nothing went out in front of the response
    clock += 10_000;
    await serve(worker, "/products/abc-123");
    expect(waits.length).toBeGreaterThan(0);
    await drain();
    expect(metrics().map((m) => m.name)).toContain("http.client.request.duration");
  });
});

describe("what the binding adds (telemetry.mdx › What's sent)", () => {
  it("tel-09/tel-27: inbound requests are measured as http.server.request.duration by route pattern and status_class, never the raw URL", async () => {
    cms();
    const worker = createDecoWorkerEntry(serverEntry, { observability: false });
    await serve(worker, "/products/abc-123?x=1");
    clock += 10_000;
    await serve(worker, "/products/abc-123?x=1");
    await drain();
    const server = metrics().find((m) => m.name === "http.server.request.duration");
    expect(server).toBeDefined();
    const points = server.histogram.dataPoints.map((p: any) => attrs(p.attributes));
    expect(points[0]).toHaveProperty("status_class", "2xx");
    expect(points[0]).toHaveProperty("http.route");
    expect(sent.map((s) => s.text).join("\n")).not.toContain("abc-123");
  });

  it("tel-10: edge cache hits and misses are measured with a cache layer and an outcome", async () => {
    fakeCaches();
    cms();
    const worker = createDecoWorkerEntry(serverEntry, { observability: false });
    await serve(worker, "/products/abc-123");
    clock += 10_000;
    await serve(worker, "/products/abc-123");
    await drain();
    const cachePoints = metrics()
      .flatMap((m) => m.histogram?.dataPoints ?? m.sum?.dataPoints ?? [])
      .map((p: any) => attrs(p.attributes))
      .filter((a: Record<string, unknown>) => Object.keys(a).some((k) => /cache/.test(k)));
    expect(cachePoints.length).toBeGreaterThan(0);
  });
});

describe("upstream data (caching.mdx)", () => {
  it("cache-03/tel-15/cache-05: upstream GETs are cached with the Cache API; a hit is labeled cached=true", async () => {
    const { cache } = fakeCaches();
    cms();
    const worker = createDecoWorkerEntry(serverEntry, { observability: false });
    // Two different pages (so the page cache can't answer) calling the same upstream URL.
    await serve(worker, "/products/a");
    await serve(worker, "/products/b");
    expect(upstreamCalls).toHaveLength(1);
    expect(cache.put).toHaveBeenCalled();
    clock += 10_000;
    await serve(worker, "/products/other");
    await drain();
    const client = metrics().find((m) => m.name === "http.client.request.duration");
    const labels = client.histogram.dataPoints.map((p: any) => attrs(p.attributes).cached);
    expect(labels).toContain(true);
    expect(labels).toContain(false);
  });

  it("cache-06: while a draft is rendered, upstream calls bypass the cache", async () => {
    const { cache, puts } = fakeCaches();
    cms();
    const worker = createDecoWorkerEntry(serverEntry, { observability: false });
    // Without a draft, the second call is a cache hit (the precondition).
    await serve(worker, "/products/a");
    await serve(worker, "/products/b");
    expect(upstreamCalls).toHaveLength(1);
    const putsBefore = puts.length;
    cache.match.mockClear();
    const draft = { cookie: `${DRAFT_COOKIE}=${encodeURIComponent("content.example/drafts/1@v1")}` };
    await serve(worker, "/products/c", draft);
    await serve(worker, "/products/d", draft);
    expect(upstreamCalls).toHaveLength(3);
    expect(puts.length).toBe(putsBefore);
  });
});
