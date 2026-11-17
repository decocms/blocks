import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INFLIGHT_TIMEOUT_MS } from "../sdk/inflightTimeout";
import {
  registerCommerceLoader,
  registerLayoutSections,
  registerSections,
  resolvePageSections,
  setBlocks,
  unregisterCommerceLoader,
  unregisterLayoutSections,
} from "./index";

// A layout section (Header, Footer) is resolved once per cache key and every
// concurrent request joins that in-flight resolution. On Cloudflare Workers the
// resolution's I/O and timers belong to the request that started it: when that
// client disconnects, the runtime cancels them, the shared Promise never
// settles, and the owner's `withInflightTimeout` never fires. These tests
// reproduce that by holding the owner's loader open and clearing the owner's
// timers (what the runtime does to a cancelled request).

// The layout cache key is the section's block key (+ device), and the TTL cache
// outlives a test: each test resolves its own section type.
const registered: Array<{ footer: string; loader: string }> = [];

/** Register a layout Footer whose props call `loader`; returns its raw section. */
function setup(name: string, loader: () => Promise<unknown>) {
  const footer = `site/sections/CancelledOwner-${name}.tsx`;
  const loaderKey = `site/loaders/cancelledOwner-${name}.ts`;
  registerSections({ [footer]: async () => ({ default: () => null }) });
  registerLayoutSections([footer]);
  registerCommerceLoader(loaderKey, loader);
  setBlocks({});
  registered.push({ footer, loader: loaderKey });
  return [{ __resolveType: footer, data: { __resolveType: loaderKey } }];
}

afterEach(() => {
  for (const { footer, loader } of registered.splice(0)) {
    unregisterLayoutSections([footer]);
    unregisterCommerceLoader(loader);
  }
  vi.useRealTimers();
});

describe("layout sections — owner request cancelled", () => {
  it("a request joining a dead flight resolves on its own timer", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const raw = setup("dead-flight", async () => {
      calls += 1;
      // First call: its request was cancelled, the Promise never settles.
      if (calls === 1) return new Promise(() => {});
      return { links: ["help"] };
    });

    void resolvePageSections(raw); // owner — its client went away
    await vi.advanceTimersByTimeAsync(0);
    // The runtime cancelled the owner's request: its inflight timeout is gone too.
    vi.clearAllTimers();

    const joiner = resolvePageSections(raw);
    await vi.advanceTimersByTimeAsync(DEFAULT_INFLIGHT_TIMEOUT_MS);

    const [section] = await joiner;
    expect(section?.props.data).toEqual({ links: ["help"] });
    expect(calls).toBe(2);
  });

  it("the replacement flight is shared: later requests join it instead of each resolving again", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let releaseSecond!: (v: unknown) => void;
    const raw = setup("replacement", () => {
      calls += 1;
      if (calls === 1) return new Promise(() => {}); // owner's request was cancelled
      return new Promise((resolve) => (releaseSecond = resolve));
    });

    void resolvePageSections(raw);
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();

    const second = resolvePageSections(raw);
    await vi.advanceTimersByTimeAsync(DEFAULT_INFLIGHT_TIMEOUT_MS);
    expect(calls).toBe(2); // the stalled joiner evicted the dead slot and resolved again

    const third = resolvePageSections(raw);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2); // joined the replacement instead of starting another

    releaseSecond({ links: ["again"] });
    const [[a], [b]] = await Promise.all([second, third]);
    expect(a?.props.data).toEqual({ links: ["again"] });
    expect(b?.props.data).toEqual({ links: ["again"] });
  });

  it("joiners of a live owner still share its single resolution", async () => {
    let release!: (v: unknown) => void;
    const loader = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const raw = setup("live-owner", loader);

    const a = resolvePageSections(raw);
    const b = resolvePageSections(raw);
    await new Promise((r) => setTimeout(r, 0));
    release({ links: ["live"] });

    const [[sa], [sb]] = await Promise.all([a, b]);
    expect(sa?.props.data).toEqual({ links: ["live"] });
    expect(sb?.props.data).toEqual({ links: ["live"] });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
