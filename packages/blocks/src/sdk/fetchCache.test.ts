/**
 * Coverage for the shared SWR fetch cache — both the caching semantics
 * (fresh HIT / dedup / SWR stale-serve / cold MISS) AND the telemetry it now
 * emits (`deco.cache.requests` with `layer: "swr"` + `profile: <provider>`).
 * The whole point of this module is that instrumentation is automatic, so the
 * metric assertions are as load-bearing as the behavioral ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureMeter, type MeterAdapter } from "../middleware/observability";
import { createFetchCache } from "./fetchCache";

interface Counter {
  name: string;
  value: number;
  labels?: Record<string, unknown>;
}

function captureMeter(): { adapter: MeterAdapter; counters: Counter[] } {
  const counters: Counter[] = [];
  const adapter: MeterAdapter = {
    counterInc(name, value, labels) {
      counters.push({ name, value: value ?? 1, labels });
    },
    histogramRecord() {},
  };
  return { adapter, counters };
}

const KNOBS = {
  maxEntries: 100,
  freshTtlMs: { success: 1000, notFound: 500, serverError: 0 },
  staleIfErrorMs: 10_000,
  inflightBackstopMs: 15_000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let counters: Counter[];

beforeEach(() => {
  const cap = captureMeter();
  counters = cap.counters;
  configureMeter(cap.adapter);
});

afterEach(() => {
  configureMeter({ counterInc: () => {} });
  vi.useRealTimers();
});

const statuses = () =>
  counters
    .filter((c) => c.name === "deco.cache.requests")
    .map((c) => c.labels?.["deco.cache.status"]);

describe("createFetchCache — behavior", () => {
  it("cold call is a MISS, second call is a HIT with the cached body", async () => {
    const cache = createFetchCache({ provider: "vtex", ...KNOBS });
    let calls = 0;
    const doFetch = () => {
      calls++;
      return Promise.resolve(jsonResponse({ ok: true }));
    };

    const a = await cache.fetchWithCache("k", doFetch);
    const b = await cache.fetchWithCache("k", doFetch);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(calls).toBe(1); // second served from cache
    expect(statuses()).toEqual(["MISS", "HIT"]);
  });

  it("dedups concurrent calls for the same key (one upstream, join = HIT)", async () => {
    const cache = createFetchCache({ provider: "vtex", ...KNOBS });
    let resolve!: (r: Response) => void;
    let calls = 0;
    const doFetch = () => {
      calls++;
      return new Promise<Response>((r) => {
        resolve = r;
      });
    };

    const p1 = cache.fetchWithCache("k", doFetch);
    const p2 = cache.fetchWithCache("k", doFetch);
    resolve(jsonResponse({ n: 1 }));
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
    expect(calls).toBe(1); // only one upstream call
    expect(statuses()).toEqual(["MISS", "HIT"]);
  });

  it("serves stale within the SIE window (STALE-HIT) and revalidates in background", async () => {
    vi.useFakeTimers();
    const cache = createFetchCache({ provider: "vtex", ...KNOBS });
    let calls = 0;
    const doFetch = () => {
      calls++;
      return Promise.resolve(jsonResponse({ v: calls }));
    };

    await cache.fetchWithCache("k", doFetch); // MISS, caches { v: 1 }
    vi.setSystemTime(Date.now() + 1500); // past 1000ms fresh TTL, within SIE

    const stale = await cache.fetchWithCache("k", doFetch); // serves last-good
    expect(stale).toEqual({ v: 1 }); // stale body returned synchronously
    await vi.runAllTimersAsync(); // let background refresh settle

    expect(statuses()).toEqual(["MISS", "STALE-HIT"]);
    expect(calls).toBe(2); // background refresh ran
  });

  it("past the SIE window the entry is dropped and refetched (MISS again)", async () => {
    vi.useFakeTimers();
    const cache = createFetchCache({ provider: "vtex", ...KNOBS });
    const doFetch = () => Promise.resolve(jsonResponse({ ok: 1 }));

    await cache.fetchWithCache("k", doFetch); // MISS
    vi.setSystemTime(Date.now() + 1000 + 10_000 + 1); // past fresh + SIE
    await cache.fetchWithCache("k", doFetch); // too stale -> cold MISS

    expect(statuses()).toEqual(["MISS", "MISS"]);
  });

  it("isolates providers — distinct instances never share entries", async () => {
    const vtex = createFetchCache({ provider: "vtex", ...KNOBS });
    const magento = createFetchCache({ provider: "magento", ...KNOBS });
    await vtex.fetchWithCache("k", () => Promise.resolve(jsonResponse({ p: "vtex" })));
    const fromMagento = await magento.fetchWithCache("k", () =>
      Promise.resolve(jsonResponse({ p: "magento" })),
    );
    expect(fromMagento).toEqual({ p: "magento" }); // magento MISS, not vtex's entry
  });
});

describe("createFetchCache — telemetry labels", () => {
  it("stamps layer=swr and provider=<provider> on every emit (profile stays unset)", async () => {
    const cache = createFetchCache({ provider: "magento", ...KNOBS });
    await cache.fetchWithCache("k", () => Promise.resolve(jsonResponse({})));
    const emitted = counters.filter((c) => c.name === "deco.cache.requests");
    expect(emitted.length).toBe(1);
    expect(emitted[0]?.labels?.["layer"]).toBe("swr");
    expect(emitted[0]?.labels?.["provider"]).toBe("magento");
    // profile is reserved for the edge layer's page-type — must NOT be set here.
    expect(emitted[0]?.labels?.["profile"]).toBeUndefined();
    expect(emitted[0]?.labels?.["deco.cache.status"]).toBe("MISS");
  });

  it("is a no-op with no meter configured (never throws)", async () => {
    configureMeter({ counterInc: () => {} });
    const cache = createFetchCache({ provider: "vtex", ...KNOBS });
    await expect(
      cache.fetchWithCache("k", () => Promise.resolve(jsonResponse({}))),
    ).resolves.toEqual({});
  });
});
