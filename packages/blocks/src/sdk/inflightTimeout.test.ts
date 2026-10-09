import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INFLIGHT_TIMEOUT_MS,
  getLiveInflight,
  type InflightMap,
  setInflight,
  withInflightTimeout,
} from "./inflightTimeout";

describe("withInflightTimeout", () => {
  it("returns the underlying value when work settles in time", async () => {
    const result = await withInflightTimeout(Promise.resolve(42), "ok-case");
    expect(result).toBe(42);
  });

  it("propagates rejection when underlying work rejects in time", async () => {
    await expect(
      withInflightTimeout(Promise.reject(new Error("boom")), "reject-case"),
    ).rejects.toThrow("boom");
  });

  it("rejects with a timeout error when underlying work never settles", async () => {
    vi.useFakeTimers();
    try {
      const hung = new Promise<number>(() => {});
      const raced = withInflightTimeout(hung, "hung-case", 1_000);
      // Swallow the eventual rejection so the runner doesn't see it as unhandled
      raced.catch(() => {});

      await vi.advanceTimersByTimeAsync(1_500);
      await expect(raced).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exports a sane default timeout", () => {
    expect(DEFAULT_INFLIGHT_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(DEFAULT_INFLIGHT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("getLiveInflight / setInflight", () => {
  let now = 0;
  const useClock = () => {
    now = 1_000_000;
    return vi.spyOn(Date, "now").mockImplementation(() => now);
  };

  it("does not reuse a slot older than the bound, with no timer ever running", () => {
    const clock = useClock();
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      const map: InflightMap<string, string> = new Map();
      const hung = setInflight(map, "k", new Promise<string>(() => {}), 100);
      now += 100;
      expect(getLiveInflight(map, "k", 100)).toBe(hung);
      now += 1;
      expect(getLiveInflight(map, "k", 100)).toBeUndefined();
      expect(map.has("k")).toBe(false);
      expect(timers).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
      clock.mockRestore();
    }
  });

  it("keeps the owner waiting on its own work after the slot expires", async () => {
    const clock = useClock();
    try {
      const map: InflightMap<string, string> = new Map();
      let finish!: (v: string) => void;
      const owner = setInflight(map, "k", new Promise<string>((r) => (finish = r)), 100);
      now += 101;
      expect(getLiveInflight(map, "k", 100)).toBeUndefined();
      finish("slow but fine");
      await expect(owner).resolves.toBe("slow but fine");
    } finally {
      clock.mockRestore();
    }
  });

  it("does not let an expired flight evict the newer one that replaced it", async () => {
    const clock = useClock();
    try {
      const map: InflightMap<string, string> = new Map();
      let finishOld!: (v: string) => void;
      const old = setInflight(map, "k", new Promise<string>((r) => (finishOld = r)), 100);
      now += 101;
      expect(getLiveInflight(map, "k", 100)).toBeUndefined();
      const newer = setInflight(map, "k", new Promise<string>(() => {}), 100);
      finishOld("late");
      await old;
      expect(getLiveInflight(map, "k", 100)).toBe(newer);
    } finally {
      clock.mockRestore();
    }
  });

  it("clears its own slot when the work settles", async () => {
    const map: InflightMap<string, string> = new Map();
    await setInflight(map, "k", Promise.resolve("v"));
    expect(map.has("k")).toBe(false);
  });

  it("sweeps expired slots of other keys on the next registration", () => {
    const clock = useClock();
    try {
      const map: InflightMap<string, string> = new Map();
      setInflight(map, "zombie", new Promise<string>(() => {}), 100);
      now += 50;
      setInflight(map, "young", new Promise<string>(() => {}), 100);
      now += 51;
      setInflight(map, "other", new Promise<string>(() => {}), 100);
      expect([...map.keys()].sort()).toEqual(["other", "young"]);
    } finally {
      clock.mockRestore();
    }
  });
});
