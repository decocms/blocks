/**
 * Phase 2 (D-11) coverage for the metric surface — canonical label set,
 * cache_layer, commerce_request_duration_ms. The Phase 1 logger/trace
 * tests live under `src/sdk/logger.test.ts` and `src/sdk/otel.test.ts`;
 * this file focuses on the middleware-level helpers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureMeter,
  DURATION_BUCKET_BOUNDARIES_SECONDS,
  METRIC_METADATA,
  type MeterAdapter,
  MetricNames,
  normalizePath,
  recordCacheMetric,
  recordCommerceMetric,
  recordRequestMetric,
  statusClassFor,
} from "./observability";

interface Counter {
  name: string;
  value: number;
  labels?: Record<string, unknown>;
}
interface Histogram {
  name: string;
  value: number;
  labels?: Record<string, unknown>;
}

function captureMeter(): {
  adapter: MeterAdapter;
  counters: Counter[];
  histograms: Histogram[];
} {
  const counters: Counter[] = [];
  const histograms: Histogram[] = [];
  const adapter: MeterAdapter = {
    counterInc(name, value, labels) {
      counters.push({ name, value: value ?? 1, labels });
    },
    histogramRecord(name, value, labels) {
      histograms.push({ name, value, labels });
    },
  };
  return { adapter, counters, histograms };
}

describe("statusClassFor", () => {
  it("maps 2xx / 3xx / 4xx / 5xx to canonical class labels", () => {
    expect(statusClassFor(200)).toBe("2xx");
    expect(statusClassFor(204)).toBe("2xx");
    expect(statusClassFor(301)).toBe("3xx");
    expect(statusClassFor(404)).toBe("4xx");
    expect(statusClassFor(500)).toBe("5xx");
    expect(statusClassFor(503)).toBe("5xx");
  });

  it("returns 'unknown' for out-of-range / NaN / non-numeric inputs", () => {
    expect(statusClassFor(-1)).toBe("unknown");
    expect(statusClassFor(99)).toBe("unknown");
    expect(statusClassFor(600)).toBe("unknown");
    expect(statusClassFor(Number.NaN)).toBe("unknown");
    expect(statusClassFor(Infinity)).toBe("unknown");
  });
});

describe("recordRequestMetric — canonical labels (D-11)", () => {
  afterEach(() => {
    // Reset meter so other tests start clean.
    configureMeter({ counterInc: () => {} });
  });

  it("stamps method + route_pattern + status + status_class by default", () => {
    const { adapter, counters, histograms } = captureMeter();
    configureMeter(adapter);

    recordRequestMetric("GET", "/products/abc123/p", 200, 42);

    // Canonical OTel HTTP server metric is histogram-only; the count
    // dimension is derived from the histogram's bucket counts at query
    // time, so we no longer emit a parallel `_total` counter.
    expect(counters).toHaveLength(0);
    expect(histograms).toHaveLength(1);
    expect(histograms[0]?.name).toBe(MetricNames.HTTP_SERVER_REQUEST_DURATION);
    expect(histograms[0]?.value).toBe(0.042); // seconds (semconv)
    expect(histograms[0]?.labels).toMatchObject({
      "http.request.method": "GET",
      // Default normalization: dynamic segments collapsed.
      "http.route": "/products/:slug/p",
      "http.response.status_code": 200,
      "deco.http.status_class": "2xx",
    });
  });

  it("prefers caller-supplied route_pattern over normalized path", () => {
    const { adapter, histograms } = captureMeter();
    configureMeter(adapter);

    recordRequestMetric("GET", "/anything/random/123", 200, 5, {
      route_pattern: "/_products/$slug/p",
    });

    expect(histograms[0]?.labels?.["http.route"]).toBe("/_products/$slug/p");
  });

  it("tags 5xx requests with status_class=5xx for downstream error filtering", () => {
    const { adapter, histograms } = captureMeter();
    configureMeter(adapter);

    recordRequestMetric("POST", "/checkout", 503, 120);

    expect(histograms[0]?.labels?.["deco.http.status_class"]).toBe("5xx");
    expect(histograms[0]?.labels?.["http.response.status_code"]).toBe(503);
  });

  it("propagates optional labels (outcome, cache_decision, cache_layer, region, extra)", () => {
    const { adapter, histograms } = captureMeter();
    configureMeter(adapter);

    recordRequestMetric("GET", "/", 200, 10, {
      outcome: "ok",
      cache_decision: "STALE-HIT",
      cache_layer: "edge",
      region: "GRU",
      extra: { ab_variant: "B" },
    });

    expect(histograms[0]?.labels).toMatchObject({
      "deco.http.outcome": "ok",
      "deco.cache.decision": "STALE-HIT",
      "deco.cache.layer": "edge",
      "deco.http.region": "GRU",
      ab_variant: "B",
    });
  });

  it("is a no-op when no meter is configured", () => {
    // We can't easily prove a no-op other than verifying no throw —
    // safer than calling configureMeter(null), which would mask real
    // bugs. The previous test's `afterEach` reset already gives us a
    // bare meter; this test confirms the call is benign.
    expect(() => recordRequestMetric("GET", "/", 200, 1)).not.toThrow();
  });
});

describe("recordCacheMetric — cache_layer label", () => {
  beforeEach(() => {
    configureMeter({ counterInc: () => {} });
  });

  it("stamps profile + decision + layer when all are provided", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    recordCacheMetric(true, "product", "HIT", "edge");

    expect(counters).toHaveLength(1);
    expect(counters[0]?.name).toBe(MetricNames.CACHE_REQUESTS);
    expect(counters[0]?.labels).toMatchObject({
      "profile": "product",
      "status": "HIT",
      "layer": "edge",
    });
  });

  it("records status=MISS when hit=false", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    recordCacheMetric(false, "search", "MISS", "edge");

    expect(counters[0]?.name).toBe(MetricNames.CACHE_REQUESTS);
    expect(counters[0]?.labels?.["status"]).toBe("MISS");
  });

  it("supports the legacy 3-arg signature for backward compat", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    recordCacheMetric(true, "static");

    expect(counters[0]?.labels).toEqual({
      "status": "HIT",
      "profile": "static",
    });
  });

  it("distinguishes cachedLoader vs edge vs swr layers", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    recordCacheMetric(true, "loader-x", "HIT", "cachedLoader");
    recordCacheMetric(true, undefined, "HIT", "swr", "vtex");

    expect(counters[0]?.labels?.["layer"]).toBe("cachedLoader");
    expect(counters[1]?.labels?.["layer"]).toBe("swr");
  });

  it("keeps provider (swr backend) on a separate label from profile (edge page-type)", () => {
    const { adapter, counters } = captureMeter();
    configureMeter(adapter);

    // edge: profile carries the page-type; no provider.
    recordCacheMetric(true, "product", "HIT", "edge");
    // swr: provider carries the backend; profile left unset so a
    // `sum by (profile)` panel never blends page-types with backend names.
    recordCacheMetric(true, undefined, "HIT", "swr", "magento");

    expect(counters[0]?.labels?.["profile"]).toBe("product");
    expect(counters[0]?.labels?.["provider"]).toBeUndefined();
    expect(counters[1]?.labels?.["profile"]).toBeUndefined();
    expect(counters[1]?.labels?.["provider"]).toBe("magento");
  });
});

describe("recordCommerceMetric (D-11)", () => {
  beforeEach(() => {
    configureMeter({ counterInc: () => {} });
  });

  it("emits http.client.request.duration with provider + operation labels", () => {
    const { adapter, histograms } = captureMeter();
    configureMeter(adapter);

    recordCommerceMetric(123, {
      provider: "vtex",
      operation: "intelligent-search.product_search",
      status_class: "2xx",
    });

    expect(histograms).toHaveLength(1);
    expect(histograms[0]?.name).toBe(MetricNames.HTTP_CLIENT_REQUEST_DURATION);
    expect(histograms[0]?.value).toBe(0.123); // seconds (semconv)
    expect(histograms[0]?.labels).toMatchObject({
      provider: "vtex",
      operation: "intelligent-search.product_search",
      status_class: "2xx",
    });
  });

  it("includes the cached boolean when provided", () => {
    const { adapter, histograms } = captureMeter();
    configureMeter(adapter);

    recordCommerceMetric(5, {
      provider: "shopify",
      operation: "graphql.cart_query",
      cached: true,
    });

    expect(histograms[0]?.labels?.cached).toBe(true);
  });

  it("is a no-op when no meter is configured", () => {
    expect(() =>
      recordCommerceMetric(1, { provider: "vtex", operation: "test" }),
    ).not.toThrow();
  });
});

/**
 * Guards the unit/bucket agreement. Durations are recorded in seconds, but the
 * OTel SDK's default explicit buckets are milliseconds
 * (`[0, 5, 10, 25, 50, 75, 100, 250, 500, 1000]`). A duration metric that ships
 * without `boundaries` inherits those defaults and files ~100% of real traffic
 * into the first bucket, which silently destroys every quantile computed from
 * it. These assertions exist so that regression fails here instead of in a
 * dashboard six months later.
 */
describe("METRIC_METADATA duration buckets", () => {
  it("declares second-scale boundaries for every metric measured in seconds", () => {
    const secondValued = Object.entries(METRIC_METADATA).filter(
      ([, meta]) => meta.unit === "s",
    );

    expect(secondValued.length).toBeGreaterThan(0);

    for (const [name, meta] of secondValued) {
      expect(meta.boundaries, `${name} must declare boundaries`).toBeDefined();
      // A millisecond-scaled bucket set starts at 5; a second-scaled one starts
      // well below 1. This is the exact mistake being guarded against.
      expect(meta.boundaries![0], `${name} boundaries look like milliseconds`)
        .toBeLessThan(1);
    }
  });

  it("keeps boundaries sorted ascending and free of duplicates", () => {
    const b = DURATION_BUCKET_BOUNDARIES_SECONDS;
    expect([...b]).toEqual([...new Set(b)]);
    expect([...b]).toEqual([...b].sort((x, y) => x - y));
  });

  it("covers the latency range real traffic falls in", () => {
    // Observed production averages sat between 0.14s and 0.49s, with a tail
    // past 10s on uncached loader paths. Buckets must resolve both ends.
    expect(DURATION_BUCKET_BOUNDARIES_SECONDS.some((x) => x <= 0.05)).toBe(true);
    expect(DURATION_BUCKET_BOUNDARIES_SECONDS.some((x) => x >= 10)).toBe(true);
  });
});

/**
 * `http.route` is the highest-cardinality risk on the highest-volume metric.
 * These cases are the real paths measured on production when the label reached
 * 20,714 distinct values across 6 tenants.
 */
describe("normalizePath cardinality", () => {
  it("collapses CMS content slugs", () => {
    expect(normalizePath("/mochila-de-couro")).toBe("/:slug");
    expect(normalizePath("/moveis/quarto-infantil")).toBe("/moveis/:slug");
    expect(normalizePath("/granado/eau-de-toilette-spritz-100ml")).toBe("/granado/:slug");
    expect(normalizePath("/moveis/quarto-adulto/cabeceiras-mesa-de-cabeceiras")).toBe(
      "/moveis/:slug/:slug",
    );
  });

  it("leaves bounded framework and API routes intact", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/api/sessions")).toBe("/api/sessions");
    expect(normalizePath("/deco/invoke/magento/loaders/features")).toBe(
      "/deco/invoke/magento/loaders/features",
    );
  });

  it("keeps dotfile segments readable", () => {
    expect(normalizePath("/.well-known/passkey-endpoints")).toBe("/.well-known/:slug");
  });

  it("still collapses ids and product pages", () => {
    expect(normalizePath("/produto/12345")).toBe("/produto/:id");
    expect(normalizePath("/a/deadbeefcafe")).toBe("/a/:id");
    expect(normalizePath("/some-product/p")).toBe("/:slug/p");
  });
});
