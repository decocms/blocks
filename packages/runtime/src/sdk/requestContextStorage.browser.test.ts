import { describe, expect, it } from "vitest";
// Import the browser stub explicitly by path. Vitest (no "browser" export
// condition) would otherwise resolve `@decocms/runtime/sdk/requestContextStorage`
// to the real `node:async_hooks`-backed module; here we assert the client-safe
// stand-in that Next.js's client webpack compiler selects via the "browser"
// export condition behaves exactly like the real storage does outside a request
// scope.
import { storage } from "./requestContextStorage.browser";

describe("requestContextStorage.browser (client-safe stub)", () => {
  it("getStore() returns undefined — no per-request async context on the client", () => {
    expect(storage.getStore()).toBeUndefined();
  });

  it("run() invokes the callback inline and returns its value", () => {
    let ran = false;
    const result = storage.run({} as never, () => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(true);
    expect(result).toBe(42);
  });

  it("run() does not establish a store — getStore() is still undefined inside the callback", () => {
    const inside = storage.run({} as never, () => storage.getStore());
    expect(inside).toBeUndefined();
  });
});
