import { afterEach, describe, expect, it, vi } from "vitest";
import { CSEG_GLOBAL } from "../shared.ts";
import { decoServerFnFetch } from "./index.ts";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[CSEG_GLOBAL];
  vi.unstubAllGlobals();
});

describe("decoServerFnFetch", () => {
  it("echoes the page's token on server-function URLs", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetch);
    (window as unknown as Record<string, unknown>)[CSEG_GLOBAL] = "a1b2c3d4";
    await decoServerFnFetch("/_serverFn/x?payload=1", { method: "GET" });
    await decoServerFnFetch("/_serverFn/y");
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "/_serverFn/x?payload=1&__cseg=a1b2c3d4",
      "/_serverFn/y?__cseg=a1b2c3d4",
    ]);
  });

  it("is a plain fetch without a token, or for a non-string input", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}"),
    );
    vi.stubGlobal("fetch", fetch);
    await decoServerFnFetch("/_serverFn/x");
    const request = new Request("http://x/_serverFn/z");
    (window as unknown as Record<string, unknown>)[CSEG_GLOBAL] = "a1b2c3d4";
    await decoServerFnFetch(request);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["/_serverFn/x", request]);
  });
});
