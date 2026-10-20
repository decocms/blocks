// @vitest-environment node
/**
 * `recordServerRequest` (`@decocms/blocks/metrics`): `http.server.request.duration` as it leaves for
 * the collector (name, unit, buckets, labels), its normalized labels, the
 * route function (called only while telemetry measures), and that it costs
 * nothing and never rejects with telemetry off.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetForTests } from "./cms";
import { recordServerRequest } from "./metrics";
import { resolveDestination, setCurrentTelemetry, TelemetryPipeline } from "./telemetry";

const ENDPOINT = "https://otel.example.com";
const OTEL_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

let bodies: any[];
let pipeline: TelemetryPipeline;

beforeEach(() => {
  resetForTests();
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const raw = Buffer.from(init.body as Uint8Array);
      const text =
        init.headers && (init.headers as Record<string, string>)["content-encoding"]
          ? gunzipSync(raw).toString()
          : raw.toString();
      bodies.push(JSON.parse(text));
      return new Response("{}");
    }),
  );
  pipeline = new TelemetryPipeline(
    resolveDestination({ endpoint: ENDPOINT }, "acme") as NonNullable<
      ReturnType<typeof resolveDestination>
    >,
  );
  setCurrentTelemetry(pipeline);
});
afterEach(() => {
  setCurrentTelemetry(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The data points of `http.server.request.duration` in what was sent. */
async function sentPoints() {
  await pipeline.flush();
  const metrics = bodies.flatMap((b) => b.resourceMetrics[0].scopeMetrics[0].metrics);
  const metric = metrics.find((m: any) => m.name === "http.server.request.duration");
  return {
    metric,
    points: (metric?.histogram.dataPoints ?? []).map((p: any) => ({
      ...p,
      labels: Object.fromEntries(
        p.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue]),
      ),
    })),
  };
}

describe("recordServerRequest", () => {
  it("sends http.server.request.duration in seconds, with OpenTelemetry's buckets and the five labels", async () => {
    await recordServerRequest({
      route: "/:slug/p",
      method: "GET",
      status: 200,
      cache: "HIT",
      device: "mobile",
      seconds: 0.042,
    });
    const { metric, points } = await sentPoints();
    expect(metric.unit).toBe("s");
    expect(points).toHaveLength(1);
    expect(points[0].labels).toEqual({
      "http.route": "/:slug/p",
      "http.request.method": "GET",
      status_class: "2xx",
      cache: "HIT",
      device: "mobile",
    });
    expect(points[0].explicitBounds).toEqual(OTEL_BUCKETS);
    expect(points[0].count).toBe("1");
    expect(points[0].sum).toBeCloseTo(0.042);
  });

  it("aggregates identical requests into one point", async () => {
    for (let i = 0; i < 3; i++) {
      await recordServerRequest({
        route: "/",
        method: "GET",
        status: 200,
        cache: "MISS",
        seconds: 0.1,
      });
    }
    const { points } = await sentPoints();
    expect(points).toHaveLength(1);
    expect(points[0].count).toBe("3");
  });

  it("normalizes every label to a short list of values", async () => {
    await recordServerRequest({
      route: undefined,
      method: "PROPFIND",
      status: 404,
      cache: "STALE" as "HIT",
      device: "smart-fridge" as "mobile",
      seconds: 0.01,
    });
    await recordServerRequest({
      route: "",
      method: "post",
      status: 0,
      cache: "DRAFT",
      seconds: 0.01,
    });
    await recordServerRequest({
      route: "/a",
      method: "GET",
      status: 302,
      cache: "BYPASS",
      seconds: 1,
    });
    const { points } = await sentPoints();
    expect(points.map((p: any) => p.labels)).toEqual([
      {
        "http.route": "unmatched",
        "http.request.method": "_OTHER",
        status_class: "4xx",
        cache: "BYPASS",
      },
      {
        "http.route": "unmatched",
        "http.request.method": "POST",
        status_class: "5xx",
        cache: "DRAFT",
      },
      { "http.route": "/a", "http.request.method": "GET", status_class: "3xx", cache: "BYPASS" },
    ]);
  });

  it("drops a duration that isn't a non-negative number", async () => {
    await recordServerRequest({
      route: "/",
      method: "GET",
      status: 200,
      cache: "MISS",
      seconds: Number.NaN,
    });
    await recordServerRequest({
      route: "/",
      method: "GET",
      status: 200,
      cache: "MISS",
      seconds: -1,
    });
    expect((await sentPoints()).points).toEqual([]);
  });

  it("records nothing, and never calls the route function, when content turns metrics off", async () => {
    pipeline.apply({ metrics: false });
    const route = vi.fn(() => "/");
    await recordServerRequest({ route, method: "GET", status: 200, cache: "MISS", seconds: 0.1 });
    expect(route).not.toHaveBeenCalled();
    expect((await sentPoints()).points).toEqual([]);
  });
});

describe("the route", () => {
  it("a function is called once and awaited; its template is the label", async () => {
    const sync = vi.fn(() => "/:slug/p");
    await recordServerRequest({
      route: sync,
      method: "GET",
      status: 200,
      cache: "MISS",
      seconds: 0.1,
    });
    await recordServerRequest({
      route: async () => "/search",
      method: "GET",
      status: 200,
      cache: "MISS",
      seconds: 0.1,
    });
    expect(sync).toHaveBeenCalledTimes(1);
    const { points } = await sentPoints();
    expect(points.map((p: any) => p.labels["http.route"])).toEqual(["/:slug/p", "/search"]);
  });

  it("a function that returns nothing, throws or rejects still counts the request, as unmatched", async () => {
    const base = { method: "GET", status: 200, cache: "MISS", seconds: 0.1 } as const;
    await recordServerRequest({ ...base, route: () => undefined });
    await expect(
      recordServerRequest({
        ...base,
        route: () => {
          throw new Error("no page");
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      recordServerRequest({ ...base, route: () => Promise.reject(new Error("no release")) }),
    ).resolves.toBeUndefined();
    const { points } = await sentPoints();
    expect(points).toHaveLength(1);
    expect(points[0].labels["http.route"]).toBe("unmatched");
    expect(points[0].count).toBe("3");
  });

  it("is cut to 200 characters", async () => {
    await recordServerRequest({
      route: `/${"a".repeat(300)}`,
      method: "GET",
      status: 200,
      cache: "MISS",
      seconds: 0.1,
    });
    expect((await sentPoints()).points[0].labels["http.route"]).toHaveLength(200);
  });
});

describe("telemetry off", () => {
  it("with no pipeline (no token, no endpoint) it resolves without calling the route function", async () => {
    setCurrentTelemetry(undefined);
    const route = vi.fn(() => "/");
    await expect(
      recordServerRequest({ route, method: "GET", status: 200, cache: "MISS", seconds: 0.1 }),
    ).resolves.toBeUndefined();
    expect(route).not.toHaveBeenCalled();
  });

  it("a pipeline that throws never reaches the request", async () => {
    setCurrentTelemetry({
      measuring: () => true,
      histogram: () => {
        throw new Error("boom");
      },
    } as unknown as TelemetryPipeline);
    await expect(
      recordServerRequest({ route: "/", method: "GET", status: 200, cache: "MISS", seconds: 0.1 }),
    ).resolves.toBeUndefined();
  });
});

describe("the ./metrics subpath", () => {
  it("is its own subpath, in the house shape, exporting only recordServerRequest; /fetch doesn't hold it", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    expect(pkg.exports["./metrics"]).toEqual({
      types: "./dist/v8/metrics.d.ts",
      source: "./src/v8/metrics.ts",
      default: "./dist/v8/metrics.js",
    });
    expect(Object.keys(await import("./metrics.ts"))).toEqual(["recordServerRequest"]);
    expect(Object.keys(await import("./fetch.ts"))).toEqual(["createInstrumentedFetch"]);
    const root = (await import("../index.ts")) as Record<string, unknown>;
    expect(root.recordServerRequest).toBeUndefined();
  });

  it("exports no types", () => {
    const source = readFileSync(new URL("./metrics.ts", import.meta.url), "utf-8");
    expect(source.match(/^export\s+(?:interface|type)\s+\w+/gm)).toBeNull();
  });
});
