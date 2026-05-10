import { describe, expect, it } from "vitest";
import { noopRequestStore, type RequestStore } from "./requestStore";

describe("noopRequestStore", () => {
  it("get() returns undefined when nothing is stored", () => {
    expect(noopRequestStore.get()).toBeUndefined();
  });

  it("run() invokes the callback and returns its result", () => {
    const result = noopRequestStore.run({ foo: 1 }, () => "ok");
    expect(result).toBe("ok");
  });

  it("get() inside run() still returns undefined (noop)", () => {
    let observed: unknown = "untouched";
    noopRequestStore.run({ bar: 2 }, () => {
      observed = noopRequestStore.get();
    });
    expect(observed).toBeUndefined();
  });

  it("RequestStore is a generic interface", () => {
    const store: RequestStore<{ x: number }> = noopRequestStore as RequestStore<{ x: number }>;
    expect(store.get()).toBeUndefined();
  });
});
