import {
  loadRedirects,
  matchExactRedirect,
  matchPatternRedirect,
  setRedirectSemantics,
} from "@decocms/blocks/sdk/redirects";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRedirectCache, lookupExactRedirect } from "./kvRedirects";

/** Minimal KV binding that records every read. */
function makeKV(values: Record<string, string> = {}) {
  const get = vi.fn((key: string) => Promise.resolve(values[key] ?? null));
  return { get, put: vi.fn(), delete: vi.fn() };
}

const ID = "sha-abc";
const enabled = (kv: unknown) => ({
  DECO_FAST_DEPLOY: "1",
  DECO_KV: kv,
  DECO_DEPLOYMENT_ID: ID,
});

beforeEach(() => {
  clearRedirectCache();
  vi.useRealTimers();
});

describe("lookupExactRedirect", () => {
  it("reads redirect:<id>:<path> and returns the rule", async () => {
    const kv = makeKV({ [`redirect:${ID}:/old`]: '{"to":"/new","status":301}' });
    await expect(lookupExactRedirect(enabled(kv), "/old")).resolves.toEqual({
      from: "/old",
      to: "/new",
      status: 301,
    });
  });

  it("returns null for a missing key", async () => {
    await expect(lookupExactRedirect(enabled(makeKV()), "/nope")).resolves.toBeNull();
  });

  it("caches a HIT so the same path costs one KV read", async () => {
    const kv = makeKV({ [`redirect:${ID}:/old`]: '{"to":"/new","status":307}' });
    await lookupExactRedirect(enabled(kv), "/old");
    await lookupExactRedirect(enabled(kv), "/old");
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it("caches a MISS too — that is the common case on every request", async () => {
    const kv = makeKV();
    await lookupExactRedirect(enabled(kv), "/nope");
    await lookupExactRedirect(enabled(kv), "/nope");
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the TTL, which is how a redirect edit propagates", async () => {
    // The rules live outside the decofile, so a redirect-only sync leaves the
    // revision identical and the poller has nothing to react to. The TTL is
    // the only propagation path.
    const kv = makeKV();
    await lookupExactRedirect(enabled(kv), "/soon");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    await lookupExactRedirect(enabled(kv), "/soon");
    expect(kv.get).toHaveBeenCalledTimes(2);
  });

  it("is inert when fast-deploy is off", async () => {
    const kv = makeKV({ [`redirect:${ID}:/old`]: '{"to":"/new","status":301}' });
    const env = { DECO_KV: kv, DECO_DEPLOYMENT_ID: ID }; // no DECO_FAST_DEPLOY
    await expect(lookupExactRedirect(env, "/old")).resolves.toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("never reads another deployment's keys when the id is unresolvable", async () => {
    const kv = makeKV();
    await lookupExactRedirect({ DECO_FAST_DEPLOY: "1", DECO_KV: kv }, "/old");
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("treats a KV failure as no-redirect, never a throw", async () => {
    // A KV outage must not 5xx a page that would otherwise render fine.
    const kv = { get: vi.fn(() => Promise.reject(new Error("KV down"))) };
    await expect(lookupExactRedirect(enabled(kv), "/old")).resolves.toBeNull();
  });

  it("treats a malformed value as no-redirect", async () => {
    const kv = makeKV({ [`redirect:${ID}:/old`]: "not json" });
    await expect(lookupExactRedirect(enabled(kv), "/old")).resolves.toBeNull();
  });

  it("answers an unknown status as temporary rather than inventing a permanent redirect", async () => {
    const kv = makeKV({ [`redirect:${ID}:/old`]: '{"to":"/new"}' });
    await expect(lookupExactRedirect(enabled(kv), "/old")).resolves.toMatchObject({ status: 302 });
  });

  it("looks the request path up under its folded key", async () => {
    const kv = makeKV({ [`redirect:${ID}:/old`]: '{"from":"/Old/","to":"/new","status":307}' });
    await expect(lookupExactRedirect(enabled(kv), "/OLD/")).resolves.toMatchObject({
      to: "/new",
      status: 302,
    });
  });
});

describe("lookupExactRedirect — semantics", () => {
  afterEach(() => setRedirectSemantics("legacy"));
  const value = JSON.stringify([
    { from: "/meia/p", to: "/a", status: 307 },
    { from: "/Meia/p/", to: "/b", status: 307 },
  ]);

  it("legacy serves the last rule under the key, temporary as 302", async () => {
    const kv = makeKV({ [`redirect:${ID}:/meia/p`]: value });
    await expect(lookupExactRedirect(enabled(kv), "/meia/p")).resolves.toMatchObject({
      to: "/b",
      status: 302,
    });
  });

  it("fresh serves the rule written byte for byte, temporary as 307", async () => {
    setRedirectSemantics("fresh");
    const kv = makeKV({ [`redirect:${ID}:/meia/p`]: value });
    await expect(lookupExactRedirect(enabled(kv), "/meia/p")).resolves.toMatchObject({
      to: "/a",
      status: 307,
    });
    clearRedirectCache();
    await expect(lookupExactRedirect(enabled(kv), "/MEIA/p")).resolves.toBeNull();
  });
});

describe("precedence: exact (KV) over glob (memory)", () => {
  it("an exact rule in KV wins over a glob still in the decofile", async () => {
    // This is why matchRedirect was split in two. Doing "matchRedirect, then
    // KV" would return /store/sale here, inverting the precedence every
    // non-fast-deploy path has.
    const map = loadRedirects({
      r: {
        __resolveType: "website/loaders/redirects.ts",
        redirects: [{ from: "/shop/*", to: "/store/*" }],
      },
    });
    const kv = makeKV({ [`redirect:${ID}:/shop/sale`]: '{"to":"/promo","status":301}' });

    const hit =
      matchExactRedirect("/shop/sale", map) ??
      (await lookupExactRedirect(enabled(kv), "/shop/sale")) ??
      matchPatternRedirect("/shop/sale", map);

    expect(hit).toMatchObject({ to: "/promo", status: 301 });
  });

  it("falls through to the glob when KV has no exact rule", async () => {
    const map = loadRedirects({
      r: {
        __resolveType: "website/loaders/redirects.ts",
        redirects: [{ from: "/shop/*", to: "/store/*" }],
      },
    });
    const hit =
      matchExactRedirect("/shop/other", map) ??
      (await lookupExactRedirect(enabled(makeKV()), "/shop/other")) ??
      matchPatternRedirect("/shop/other", map);

    expect(hit).toMatchObject({ to: "/store/other" });
  });
});
