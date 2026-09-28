import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_DEFERRED_TRIGGER, getDeferredTrigger } from "./deferredTrigger";

/**
 * `getDeferredTrigger()` is the client-side half of `deferredTrigger`. It must
 * read the same `globalThis.__deco.asyncConfig` bag `setAsyncRenderingConfig()`
 * writes WITHOUT importing `resolve.ts` — that module pulls `node:async_hooks`
 * and `node:fs/promises`, which a browser bundle cannot take (see the header of
 * `cms/client.ts`). So this file imports only the standalone module, and sets
 * the global by hand.
 */
describe("getDeferredTrigger", () => {
  beforeEach(() => {
    delete (globalThis as any).__deco;
  });

  it("falls back to intersection when setAsyncRenderingConfig() never ran", () => {
    expect(getDeferredTrigger()).toBe("intersection");
    expect(DEFAULT_DEFERRED_TRIGGER).toBe("intersection");
  });

  it("falls back to intersection when the config exists but omits the option", () => {
    (globalThis as any).__deco = { asyncConfig: { respectCmsLazy: true } };
    expect(getDeferredTrigger()).toBe("intersection");
  });

  it("reads load off the shared global", () => {
    (globalThis as any).__deco = { asyncConfig: { deferredTrigger: "load" } };
    expect(getDeferredTrigger()).toBe("load");
  });
});
