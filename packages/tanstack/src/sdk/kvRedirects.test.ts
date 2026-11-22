import { redirectPathHash } from "@decocms/blocks/cms";
import {
  loadRedirects,
  matchExactRedirect,
  matchPatternRedirect,
  setRedirectSemantics,
} from "@decocms/blocks/sdk/redirects";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRedirectCache, lookupExactRedirect, REDIRECT_INDEX_TIMEOUT_MS } from "./kvRedirects";

/** Minimal KV binding: `rules` records the `redirect:*` reads, `index` the
 * reads of the deployment's `index:redirects:<id>`. */
function makeKV(values: Record<string, string> = {}) {
  const read = (key: string) => Promise.resolve(values[key] ?? null);
  const rules = vi.fn(read);
  const index = vi.fn(read);
  const get = (key: string) => (key.startsWith("index:redirects:") ? index(key) : rules(key));
  return { get, rules, index, put: vi.fn(), delete: vi.fn() };
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

  it("only navigations read KV: POST/PUT skip the lookup entirely", async () => {
    const kv = makeKV({ [`redirect:${ID}:/old`]: '{"to":"/new","status":301}' });
    await expect(lookupExactRedirect(enabled(kv), "/old", "POST")).resolves.toBeNull();
    await expect(lookupExactRedirect(enabled(kv), "/old", "PUT")).resolves.toBeNull();
    expect(kv.rules).not.toHaveBeenCalled();
    await expect(lookupExactRedirect(enabled(kv), "/old", "HEAD")).resolves.toMatchObject({
      to: "/new",
    });
    expect(kv.rules).toHaveBeenCalledTimes(1);
  });

  it("returns null for a missing key", async () => {
    await expect(lookupExactRedirect(enabled(makeKV()), "/nope")).resolves.toBeNull();
  });

  it("caches a HIT so the same path costs one KV read", async () => {
    const kv = makeKV({ [`redirect:${ID}:/old`]: '{"to":"/new","status":307}' });
    await lookupExactRedirect(enabled(kv), "/old");
    await lookupExactRedirect(enabled(kv), "/old");
    expect(kv.rules).toHaveBeenCalledTimes(1);
  });

  it("caches a MISS too — that is the common case on every request", async () => {
    const kv = makeKV();
    await lookupExactRedirect(enabled(kv), "/nope");
    await lookupExactRedirect(enabled(kv), "/nope");
    expect(kv.rules).toHaveBeenCalledTimes(1);
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
    expect(kv.rules).toHaveBeenCalledTimes(2);
  });

  it("is inert when fast-deploy is off", async () => {
    const kv = makeKV({ [`redirect:${ID}:/old`]: '{"to":"/new","status":301}' });
    const env = { DECO_KV: kv, DECO_DEPLOYMENT_ID: ID }; // no DECO_FAST_DEPLOY
    await expect(lookupExactRedirect(env, "/old")).resolves.toBeNull();
    expect(kv.rules).not.toHaveBeenCalled();
  });

  it("never reads another deployment's keys when the id is unresolvable", async () => {
    const kv = makeKV();
    await lookupExactRedirect({ DECO_FAST_DEPLOY: "1", DECO_KV: kv }, "/old");
    expect(kv.rules).not.toHaveBeenCalled();
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

describe("lookupExactRedirect — index:redirects:<id>", () => {
  const indexOf = (...paths: string[]) =>
    JSON.stringify(paths.map(redirectPathHash).sort((a, b) => a - b));
  const stored = { [`redirect:${ID}:/old`]: '{"to":"/new","status":301}' };

  it("a path outside the index reads no rule, and the index is read once", async () => {
    const kv = makeKV({ ...stored, [`index:redirects:${ID}`]: indexOf("/old", "/other") });
    await expect(lookupExactRedirect(enabled(kv), "/p/1")).resolves.toBeNull();
    await expect(lookupExactRedirect(enabled(kv), "/p/2")).resolves.toBeNull();
    expect(kv.rules).not.toHaveBeenCalled();
    expect(kv.index).toHaveBeenCalledTimes(1);
  });

  it("a path in the index is still read and redirects", async () => {
    const kv = makeKV({ ...stored, [`index:redirects:${ID}`]: indexOf("/old") });
    await expect(lookupExactRedirect(enabled(kv), "/OLD/")).resolves.toMatchObject({ to: "/new" });
    expect(kv.rules).toHaveBeenCalledTimes(1);
  });

  it("an empty index means no rule is ever read", async () => {
    const kv = makeKV({ ...stored, [`index:redirects:${ID}`]: "[]" });
    await expect(lookupExactRedirect(enabled(kv), "/old")).resolves.toBeNull();
    expect(kv.rules).not.toHaveBeenCalled();
  });

  it("without an index (a deployment synced before it existed) every path is read", async () => {
    const kv = makeKV(stored);
    await expect(lookupExactRedirect(enabled(kv), "/old")).resolves.toMatchObject({ to: "/new" });
    await expect(lookupExactRedirect(enabled(kv), "/p/1")).resolves.toBeNull();
    expect(kv.rules).toHaveBeenCalledTimes(2);
  });

  it("a malformed index is no index", async () => {
    const kv = makeKV({ ...stored, [`index:redirects:${ID}`]: "not json" });
    await expect(lookupExactRedirect(enabled(kv), "/old")).resolves.toMatchObject({ to: "/new" });
  });

  it("is read again after the TTL, so a rule added by a sync starts redirecting", async () => {
    const values: Record<string, string> = { ...stored, [`index:redirects:${ID}`]: "[]" };
    const kv = makeKV(values);
    await expect(lookupExactRedirect(enabled(kv), "/old")).resolves.toBeNull();
    values[`index:redirects:${ID}`] = indexOf("/old");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    await expect(lookupExactRedirect(enabled(kv), "/old")).resolves.toMatchObject({ to: "/new" });
    expect(kv.index).toHaveBeenCalledTimes(2);
  });
});

describe("lookupExactRedirect — an index read that never settles", () => {
  // The read in flight belongs to the request that opened it. When that
  // request is canceled its `kv.get` never settles; the requests that joined
  // it must not wait forever, and the isolate must not keep handing it out.
  const stored = { [`redirect:${ID}:/old`]: '{"to":"/new","status":301}' };

  /** KV whose first `index:redirects:*` read never settles; later ones answer `index`. */
  function makeDeadIndexKV(index: string) {
    const kv = makeKV({ ...stored, [`index:redirects:${ID}`]: index });
    const answer = kv.index.getMockImplementation()!;
    kv.index.mockImplementationOnce(() => new Promise<never>(() => {}));
    kv.index.mockImplementation(answer);
    return kv;
  }

  it("the request that opened it goes on without the index after the timeout", async () => {
    vi.useFakeTimers();
    const kv = makeDeadIndexKV("[]");
    const lookup = lookupExactRedirect(enabled(kv), "/old");
    await vi.advanceTimersByTimeAsync(REDIRECT_INDEX_TIMEOUT_MS);
    // No index ⇒ the path is read by key, as before the index existed.
    await expect(lookup).resolves.toMatchObject({ to: "/new" });
    expect(kv.rules).toHaveBeenCalledTimes(1);
  });

  it("requests that joined it are released too, not held forever", async () => {
    vi.useFakeTimers();
    const kv = makeDeadIndexKV("[]");
    const owner = lookupExactRedirect(enabled(kv), "/old");
    const joined = [
      lookupExactRedirect(enabled(kv), "/a"),
      lookupExactRedirect(enabled(kv), "/old"),
    ];
    expect(kv.index).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REDIRECT_INDEX_TIMEOUT_MS);
    await expect(owner).resolves.toMatchObject({ to: "/new" });
    await expect(Promise.all(joined)).resolves.toEqual([
      null,
      expect.objectContaining({ to: "/new" }),
    ]);
  });

  it("the dead read is dropped: the next request opens a fresh one and uses it", async () => {
    vi.useFakeTimers();
    const kv = makeDeadIndexKV("[]");
    const first = lookupExactRedirect(enabled(kv), "/old");
    await vi.advanceTimersByTimeAsync(REDIRECT_INDEX_TIMEOUT_MS);
    await first;
    kv.rules.mockClear();
    // Fresh index read answers `[]`: no rule is read for any path.
    await expect(lookupExactRedirect(enabled(kv), "/old")).resolves.toBeNull();
    await expect(lookupExactRedirect(enabled(kv), "/p/1")).resolves.toBeNull();
    expect(kv.index).toHaveBeenCalledTimes(2);
    expect(kv.rules).not.toHaveBeenCalled();
  });

  it("a read older than the timeout is not joined, even before anyone timed out", async () => {
    vi.useFakeTimers();
    const kv = makeDeadIndexKV("[]");
    void lookupExactRedirect(enabled(kv), "/x");
    // The clock moves past the deadline without the owner's timer having run
    // (e.g. the owner's context is gone): a newcomer must not join it.
    vi.setSystemTime(Date.now() + REDIRECT_INDEX_TIMEOUT_MS);
    await expect(lookupExactRedirect(enabled(kv), "/old")).resolves.toBeNull();
    expect(kv.index).toHaveBeenCalledTimes(2);
  });

  it("a healthy read in flight is still shared by concurrent requests", async () => {
    const kv = makeKV({ ...stored, [`index:redirects:${ID}`]: "[]" });
    await Promise.all([
      lookupExactRedirect(enabled(kv), "/a"),
      lookupExactRedirect(enabled(kv), "/b"),
      lookupExactRedirect(enabled(kv), "/c"),
    ]);
    expect(kv.index).toHaveBeenCalledTimes(1);
    expect(kv.rules).not.toHaveBeenCalled();
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
