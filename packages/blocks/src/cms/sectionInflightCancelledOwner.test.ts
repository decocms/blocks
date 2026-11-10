import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INFLIGHT_TIMEOUT_MS } from "../sdk/inflightTimeout";
import {
  registerCacheableSections,
  registerLayoutSections,
  registerSectionLoader,
  registerSections,
  resolveDecoPage,
  runSectionLoaders,
  setBlocks,
  unregisterLayoutSections,
} from "./index";
import type { ResolvedSection } from "./resolve";

// Same mechanism as `../sdk/cachedLoaderCancelledOwner.test.ts` (#677), for the
// dedup maps that test does not reach: cacheable section loaders, layout
// section loaders and resolved layouts. On Workers a cancelled owner request
// takes its pending I/O and timers with it, so the shared Promise never
// settles and its `withInflightTimeout` never fires. We reproduce that by never
// settling the owner's work and then clearing every pending timer.

const never = <T>() => new Promise<T>(() => {});

const req = () => new Request("https://store.test/");

const section = (component: string, props: Record<string, unknown> = {}): ResolvedSection => ({
  component,
  props,
  key: component,
});

/** Let the owner reach the point where it publishes its flight. */
const flush = () => vi.advanceTimersByTimeAsync(0);

afterEach(() => {
  vi.useRealTimers();
});

describe("cacheable section loader — owner request cancelled", () => {
  it("a joiner of a flight that never settles runs the loader itself", async () => {
    vi.useFakeTimers();
    const KEY = "site/sections/CancelledCacheable.tsx";
    let calls = 0;
    const loader = vi.fn(async (props: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) return never<Record<string, unknown>>();
      return { ...props, enriched: true };
    });
    registerSectionLoader(KEY, loader);
    registerCacheableSections({ [KEY]: { maxAge: 60_000 } });

    void runSectionLoaders([section(KEY)], req()); // owner — abandoned
    await flush();
    vi.clearAllTimers(); // the runtime cancelled the owner: its timeout is gone too

    const joiner = runSectionLoaders([section(KEY)], req());
    await vi.advanceTimersByTimeAsync(DEFAULT_INFLIGHT_TIMEOUT_MS);
    const [result] = await joiner;
    expect(result?.props).toMatchObject({ enriched: true });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("joiners of a live owner still share its single loader call", async () => {
    const KEY = "site/sections/LiveCacheable.tsx";
    let release!: (v: Record<string, unknown>) => void;
    const loader = vi.fn(() => new Promise<Record<string, unknown>>((r) => (release = r)));
    registerSectionLoader(KEY, loader);
    registerCacheableSections({ [KEY]: { maxAge: 60_000 } });

    const a = runSectionLoaders([section(KEY)], req());
    const b = runSectionLoaders([section(KEY)], req());
    await new Promise((r) => setTimeout(r, 0));
    release({ v: 1 });
    const [[ra], [rb]] = await Promise.all([a, b]);
    expect(ra?.props).toEqual({ v: 1 });
    expect(rb?.props).toEqual({ v: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe("layout section loader — owner request cancelled", () => {
  it("a joiner of a flight that never settles resolves the layout itself, with its own index", async () => {
    vi.useFakeTimers();
    const KEY = "site/sections/CancelledHeader.tsx";
    let calls = 0;
    const loader = vi.fn(async (props: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) return never<Record<string, unknown>>();
      return { ...props, menu: ["a"] };
    });
    registerSectionLoader(KEY, loader);
    registerLayoutSections([KEY]);

    try {
      void runSectionLoaders([{ ...section(KEY), index: 0 }], req()); // owner — abandoned
      await flush();
      vi.clearAllTimers();

      const joiner = runSectionLoaders([{ ...section(KEY), index: 3 }], req());
      await vi.advanceTimersByTimeAsync(DEFAULT_INFLIGHT_TIMEOUT_MS);
      const [result] = await joiner;
      expect(result?.props).toMatchObject({ menu: ["a"] });
      expect(result?.index).toBe(3);
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      unregisterLayoutSections([KEY]);
    }
  });
});

describe("resolved layout (resolveDecoPage) — owner request cancelled", () => {
  it("a page whose layout flight never settles still resolves", async () => {
    vi.useFakeTimers();
    const FOOTER = "site/sections/CancelledFooter.tsx";
    let imports = 0;
    registerSections({
      [FOOTER]: () => {
        imports += 1;
        // First resolution belongs to the cancelled owner and never settles.
        if (imports === 1) return never();
        return Promise.resolve({ default: () => null });
      },
    });
    registerLayoutSections([FOOTER]);
    setBlocks({
      "pages-cancelled-layout": {
        path: "/cancelled-layout",
        sections: [{ __resolveType: FOOTER }],
      },
    });

    try {
      void resolveDecoPage("/cancelled-layout"); // owner — abandoned
      await flush();
      vi.clearAllTimers();

      const joiner = resolveDecoPage("/cancelled-layout");
      await vi.advanceTimersByTimeAsync(DEFAULT_INFLIGHT_TIMEOUT_MS);
      const page = await joiner;
      expect(page?.resolvedSections.some((s) => s.component === FOOTER)).toBe(true);
    } finally {
      unregisterLayoutSections([FOOTER]);
    }
  });
});
