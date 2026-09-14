import { describe, expect, it, vi } from "vitest";
import { createNativeSession } from "./session";

describe("createNativeSession", () => {
  it("gets out of the way when the platform owns cookies", () => {
    const fetcher = vi.fn();
    const session = createNativeSession({ strategy: "platform", fetcher: fetcher as never });
    expect(session.platformManaged).toBe(true);
    expect(session.jar).toBeUndefined();
    // The transport must be the caller's, UNWRAPPED. Any wrapper that sets a
    // `Cookie` header overrides the OS store, and the server echoing that value
    // back grows it on every round trip until the backend stops recognising it.
    expect(session.fetcher).toBe(fetcher);
  });

  it("carries the session itself when nothing else does", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}", { headers: { "set-cookie": "cart=abc; Path=/" } }),
    );
    const session = createNativeSession({ strategy: "jar", fetcher: fetcher as never });
    expect(session.platformManaged).toBe(false);
    expect(session.jar).toBeDefined();

    await session.fetcher("https://loja.example.com/deco/invoke/x");
    await session.fetcher("https://loja.example.com/deco/invoke/x");

    // Second call carries what the first one was given — that is the whole job.
    const second = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(second.headers).get("cookie")).toBe("cart=abc");
  });

  it("defaults to the jar outside React Native", () => {
    // Node, a bundler probe, Expo web: nothing persists cookies for us.
    expect(createNativeSession().platformManaged).toBe(false);
  });

  it("hands the jar straight to createNativeInvoke's contract", () => {
    // `jar ?? false` is the documented one-liner: `false` means "platform owns
    // it". A session that returned a live jar on iOS would silently
    // reintroduce the corruption.
    expect(createNativeSession({ strategy: "platform" }).jar ?? false).toBe(false);
    expect(createNativeSession({ strategy: "jar" }).jar ?? false).not.toBe(false);
  });
});
