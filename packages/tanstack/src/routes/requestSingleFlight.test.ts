import { describe, expect, it, vi } from "vitest";
import { createRequestSingleFlight } from "./requestSingleFlight";

describe("request-scoped page single-flight", () => {
  it("lets a healthy visitor complete while an earlier visitor's page is stuck", async () => {
    const load = createRequestSingleFlight<string>();
    const path = "/granado/sabonetes/sabonete-barra";
    let release!: (value: string) => void;
    const first = load(
      new Request(`https://shop.test${path}`),
      path,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const healthy = load(
      new Request(`https://shop.test${path}`),
      path,
      async () => "healthy visitor",
    );
    try {
      expect(
        await Promise.race([
          healthy,
          new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
        ]),
      ).toBe("healthy visitor");
    } finally {
      release("earlier visitor");
      await first;
    }
  });

  it("deduplicates concurrent callers within one request and removes completed work", async () => {
    const load = createRequestSingleFlight<string>();
    const request = new Request("https://shop.test/category");
    const run = vi.fn(async () => "page");
    const first = load(request, "/category", run);
    expect(load(request, "/category", run)).toBe(first);
    await first;
    await load(request, "/category", run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps page options separate and allows retry after a failure", async () => {
    const load = createRequestSingleFlight<string>();
    const request = new Request("https://shop.test/category");
    await expect(
      load(request, "/category", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(await load(request, "/category", async () => "retry")).toBe("retry");
    const results = await Promise.all([
      load(request, "/category?p=1", async () => "first page"),
      load(request, "/category?p=2", async () => "second page"),
      load(request, "/category?p=1|noGlobals", async () => "without globals"),
    ]);
    expect(results).toEqual(["first page", "second page", "without globals"]);
  });
});
