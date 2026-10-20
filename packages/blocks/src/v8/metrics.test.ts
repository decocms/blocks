// @vitest-environment node
/**
 * `@decocms/blocks/metrics`: `http.server.request.duration` as it leaves for
 * the collector (name, unit, buckets, labels), its normalized labels, and
 * that it costs nothing and never throws with telemetry off.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetForTests } from "./cms";
import { measuringServerRequests, recordServerRequest } from "./metrics";
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
    recordServerRequest({
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
      recordServerRequest({ route: "/", method: "GET", status: 200, cache: "MISS", seconds: 0.1 });
    }
    const { points } = await sentPoints();
    expect(points).toHaveLength(1);
    expect(points[0].count).toBe("3");
  });

  it("normalizes every label to a short list of values", async () => {
    recordServerRequest({
      method: "PROPFIND",
      status: 404,
      cache: "STALE" as "HIT",
      device: "smart-fridge",
      seconds: 0.01,
    });
    recordServerRequest({ route: "", method: "post", status: 0, cache: "DRAFT", seconds: 0.01 });
    recordServerRequest({ route: "/a", method: "GET", status: 302, cache: "BYPASS", seconds: 1 });
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
    recordServerRequest({ method: "GET", status: 200, cache: "MISS", seconds: Number.NaN });
    recordServerRequest({ method: "GET", status: 200, cache: "MISS", seconds: -1 });
    expect((await sentPoints()).points).toEqual([]);
  });

  it("records nothing and reports not measuring when content turns metrics off", async () => {
    pipeline.apply({ metrics: false });
    expect(measuringServerRequests()).toBe(false);
    recordServerRequest({ method: "GET", status: 200, cache: "MISS", seconds: 0.1 });
    expect((await sentPoints()).points).toEqual([]);
  });
});

describe("telemetry off", () => {
  it("with no pipeline (no token, no endpoint) it measures nothing and never throws", () => {
    setCurrentTelemetry(undefined);
    expect(measuringServerRequests()).toBe(false);
    expect(() =>
      recordServerRequest({ method: "GET", status: 200, cache: "MISS", seconds: 0.1 }),
    ).not.toThrow();
  });

  it("a pipeline that throws never reaches the request", () => {
    setCurrentTelemetry({
      measuring: () => true,
      histogram: () => {
        throw new Error("boom");
      },
    } as unknown as TelemetryPipeline);
    expect(() =>
      recordServerRequest({ method: "GET", status: 200, cache: "MISS", seconds: 0.1 }),
    ).not.toThrow();
  });
});

describe("the ./metrics subpath", () => {
  it("package.json maps it to the source and the build", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    expect(pkg.exports["./metrics"]).toEqual({
      types: "./dist/v8/metrics.d.ts",
      source: "./src/v8/metrics.ts",
      default: "./dist/v8/metrics.js",
    });
  });

  it("exports the recorder and its guard, nothing else", async () => {
    expect(Object.keys(await import("./metrics.ts")).sort()).toEqual([
      "measuringServerRequests",
      "recordServerRequest",
    ]);
  });
});
