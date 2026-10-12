// @vitest-environment node
/**
 * createInstrumentedFetch (api-reference#createinstrumentedfetch-options,
 * upstream-clients.mdx): one measurement per request, retries counted once,
 * an opt-in circuit breaker, and nothing measured without telemetry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetForTests } from "./cms";
import { createInstrumentedFetch } from "./fetch";
import { setCurrentTelemetry, type TelemetryPipeline } from "./telemetry";

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
