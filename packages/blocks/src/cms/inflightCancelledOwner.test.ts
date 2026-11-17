/**
 * Cancelled-owner regression for the module-level single-flight maps in
 * sectionLoaders.ts (`layoutInflight`, `sectionLoaderInflight`) and resolve.ts
 * (`resolvedLayoutInflight`).
 *
 * On Workers, when the client of the request that OWNS a shared flight
 * disconnects, the runtime cancels that request's I/O and timers — including
 * the owner's `withInflightTimeout`. The flight never settles and every later
 * request for the same key used to hang for the life of the isolate (CPU ~0,
 * wall 100s → 524). Simulated here: the owner's work never settles and
 * `withInflightTimeout` is a pass-through (its timer "died" with the owner).
 * Joiners must recover on their own timer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../sdk/inflightTimeout", async (importActual) => ({
  ...(await importActual<typeof import("../sdk/inflightTimeout")>()),
  withInflightTimeout: <T>(work: Promise<T>) => work,
}));

import { bindCacheStorage } from "../sdk/cacheStorage";
import { RequestContext } from "../sdk/requestContext";
import {
  registerCacheableSections,
  registerLayoutSections,
  registerSectionLoader,
  registerSections,
  resolveDecoPage,
  runSingleSectionLoader,
  setBlocks,
  unregisterLayoutSections,
} from "./index";
import type { ResolvedSection } from "./resolve";

const section = (component: string, index: number): ResolvedSection =>
  ({ component, props: {}, key: `${component}-${index}`, index }) as ResolvedSection;

/** First call never settles (owner's request was cancelled); later calls resolve. */
function deadThenAlive() {
  let calls = 0;
  const loader = vi.fn(async (props: Record<string, unknown>) => {
    calls++;
    if (calls === 1) return new Promise<Record<string, unknown>>(() => {});
    return { ...props, run: calls };
  });
  return loader;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("single-flight joiners of a cancelled owner do not hang", () => {
  it("layout section: joiners rerun after their own timer and keep their own index", async () => {
    vi.useFakeTimers();
    const TYPE = "site/sections/CancelHeader.tsx";
    const loader = deadThenAlive();
    registerSectionLoader(TYPE, loader);
    registerLayoutSections([TYPE]);
    const request = new Request("https://store.com/p");
    try {
      void runSingleSectionLoader(section(TYPE, 0), request);
      const joiners = [1, 2, 3, 4, 5].map((i) => runSingleSectionLoader(section(TYPE, i), request));
      await vi.advanceTimersByTimeAsync(10_000);
      const results = await Promise.all(joiners);

      expect(results.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
      expect(results.every((r) => (r.props as { run?: number }).run === 2)).toBe(true);
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      unregisterLayoutSections([TYPE]);
    }
  });

  it("cacheable section: joiners rerun after their own timer instead of hanging", async () => {
    vi.useFakeTimers();
    const TYPE = "site/sections/CancelShelf.tsx";
    const loader = deadThenAlive();
    registerSectionLoader(TYPE, loader);
    registerCacheableSections({ [TYPE]: { maxAge: 60_000 } });
    const request = new Request("https://store.com/p");

    void runSingleSectionLoader(section(TYPE, 0), request);
    const joiners = [1, 2, 3].map((i) => runSingleSectionLoader(section(TYPE, i), request));
    await vi.advanceTimersByTimeAsync(10_000);
    const results = await Promise.all(joiners);

    expect(results.every((r) => (r.props as { run?: number }).run === 2)).toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("resolved layout (Header/Footer in resolveDecoPage): a page joining a dead flight still resolves", async () => {
    vi.useFakeTimers();
    const FOOTER = "site/sections/CancelFooter.tsx";
    let imports = 0;
    registerSections({
      [FOOTER]: () => {
        imports++;
        return imports === 1 ? new Promise(() => {}) : Promise.resolve({ default: () => null });
      },
    });
    registerLayoutSections([FOOTER]);
    setBlocks({
      "pages-cancel-a": { path: "/cancel-a", sections: [{ __resolveType: FOOTER }] },
      "pages-cancel-b": { path: "/cancel-b", sections: [{ __resolveType: FOOTER }] },
    });
    try {
      void resolveDecoPage("/cancel-a");
      await vi.advanceTimersByTimeAsync(0);
      const joiner = resolveDecoPage("/cancel-b");
      await vi.advanceTimersByTimeAsync(10_000);
      const page = await joiner;

      expect(page?.resolvedSections.some((s) => s.component === FOOTER)).toBe(true);
      expect(imports).toBeGreaterThanOrEqual(2);
    } finally {
      unregisterLayoutSections([FOOTER]);
    }
  });

  it("the owner's shared work is handed to ctx.waitUntil so a client disconnect does not kill it", async () => {
    const TYPE = "site/sections/WaitUntilHeader.tsx";
    registerSectionLoader(TYPE, async (p: Record<string, unknown>) => p);
    registerLayoutSections([TYPE]);
    const request = new Request("https://store.com/p");
    const waitUntil = vi.fn();
    try {
      await RequestContext.run(request, async () => {
        bindCacheStorage({ storage: null, scope: "test", waitUntil });
        await runSingleSectionLoader(section(TYPE, 0), request);
      });
      expect(waitUntil).toHaveBeenCalled();
      expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    } finally {
      unregisterLayoutSections([TYPE]);
    }
  });
});
