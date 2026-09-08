import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureMeter, MetricNames } from "../middleware/observability";
import { clearLoaderCache, createCachedLoader } from "./cachedLoader";

type Sample = { name: string; value: number; labels?: Record<string, unknown> };

function fakeMeter(samples: Sample[]) {
  return {
    counterInc: () => {},
    gaugeSet: () => {},
    histogramRecord: (name: string, value: number, labels?: Record<string, unknown>) => {
      samples.push({ name, value, labels });
    },
  };
}

const sizeSamples = (samples: Sample[]) => samples.filter((s) => s.name === MetricNames.CACHE_SIZE);

describe("deco.cache.size — emitted on every loader cache write", () => {
  let samples: Sample[];

  beforeEach(() => {
    clearLoaderCache();
    samples = [];
    configureMeter(fakeMeter(samples));
  });

  afterEach(() => {
    clearLoaderCache();
    configureMeter({ counterInc: () => {} }); // drop the recorder
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records one sample on the cold-miss write, labelled op=set + the loader name", async () => {
    const cached = createCachedLoader("t/size-miss", async (p: { id: number }) => ({ v: p.id }), {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });

    await cached({ id: 1 });

    const sizes = sizeSamples(samples);
    expect(sizes).toHaveLength(1);
    expect(sizes[0].labels).toEqual({ op: "set", profile: "t/size-miss" });
    // Bytes, not seconds — and floored at MIN_ENTRY_BYTES for a tiny payload.
    expect(sizes[0].value).toBe(512);
  });

  it("does not re-record on a HIT — only writes are measured", async () => {
    const cached = createCachedLoader("t/size-hit", async (p: { id: number }) => ({ v: p.id }), {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });

    await cached({ id: 1 }); // MISS -> write
    await cached({ id: 1 }); // HIT  -> no write

    expect(sizeSamples(samples)).toHaveLength(1);
  });

  it("records the SWR background-refresh write too, not just the cold miss", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T16:00:00.000Z"));

    const cached = createCachedLoader("t/size-swr", async (p: { id: number }) => ({ v: p.id }), {
      policy: "stale-while-revalidate",
      maxAge: 1_000,
    });

    await cached({ id: 1 }); // MISS -> write #1
    vi.setSystemTime(new Date("2026-05-18T16:00:05.000Z")); // now stale
    await cached({ id: 1 }); // STALE-HIT -> background refresh
    await vi.runAllTimersAsync(); // let the refresh settle

    const sizes = sizeSamples(samples);
    expect(sizes).toHaveLength(2); // write #2 came from the refresh
    expect(sizes.every((s) => s.labels?.op === "set")).toBe(true);
    expect(sizes.every((s) => s.labels?.profile === "t/size-swr")).toBe(true);
  });

  it("scales with the payload so a fat loader is distinguishable from a thin one", async () => {
    const big = { blob: "x".repeat(50_000) };
    const cached = createCachedLoader("t/size-big", async () => big, {
      policy: "stale-while-revalidate",
      maxAge: 60_000,
    });

    await cached({});

    expect(sizeSamples(samples)[0].value).toBeGreaterThan(50_000);
  });
});
