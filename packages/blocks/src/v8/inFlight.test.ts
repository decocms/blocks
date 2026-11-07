// @vitest-environment node
/**
 * Shared fetches outlive the request that started them (see ./blockStore.ts):
 * on a runtime that stops a request's I/O with its response (Cloudflare
 * Workers), a body one request only prefetched must still reach the next
 * request that needs it, and a fetch whose request went away is never
 * awaited forever.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockStore } from "./blockStore";
import { createCMS, resetForTests } from "./cms";
import { ContentUnavailableError } from "./errors";
import { matchRoute } from "./matchRoute";
import { docsBlocks, fakeDelivery, fakeStudio } from "./testFixtures";
import type { Blocks } from "./types";

const SITE = "acme";
const BACKGROUND_HOOK = Symbol.for("decocms.blocks.background");

/**
 * A request's I/O context, as workerd keeps one: alive while its handler
 * runs and while a promise it gave `waitUntil` is pending. A response that
 * arrives once it is gone never reaches anyone.
 */
class RequestContext {
  #ended = false;
  #kept = 0;
  get alive(): boolean {
    return !this.#ended || this.#kept > 0;
  }
  end(): void {
    this.#ended = true;
  }
  waitUntil(promise: Promise<unknown>): void {
    this.#kept++;
    const done = () => {
      this.#kept--;
    };
    promise.then(done, done);
  }
}

/** A fake workerd: requests in their own contexts, `fetch` bound to the caller's, `waitUntil` as the background hook. */
function fakeRuntime(
  api: { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> },
  options: { waitUntil: boolean },
) {
  const contexts = new AsyncLocalStorage<RequestContext>();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const ctx = contexts.getStore();
    const response = await api.fetch(input, init);
    await new Promise((resolve) => setTimeout(resolve, 1));
    // The request that started it is gone: the I/O is cancelled, the promise never settles.
    if (ctx !== undefined && !ctx.alive) return new Promise<Response>(() => {});
    return response;
  });
  if (options.waitUntil) {
    (globalThis as Record<symbol, unknown>)[BACKGROUND_HOOK] = (task: () => Promise<void>) => {
      const promise = task();
      contexts.getStore()?.waitUntil(promise);
    };
  }
  return {
    /** Runs `handler` as one request; its context ends with its answer. */
    async serve<T>(handler: () => Promise<T>): Promise<T> {
      const ctx = new RequestContext();
      try {
        return await contexts.run(ctx, handler);
      } finally {
        ctx.end();
      }
    },
  };
}

beforeEach(() => resetForTests());
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[BACKGROUND_HOOK];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const blocks = (): Blocks => ({
  ...docsBlocks(),
  "site/sections/Text.tsx": (props: unknown) => props,
});

/** A catch-all page, a product page and the redirects block, with a rule for /shirts. */
function site(): Record<string, unknown> {
  return {
    catchAll: {
      __resolveType: "page",
      path: "/*",
      sections: [{ __resolveType: "site/sections/Text.tsx", text: "catch-all" }],
    },
    product: {
      __resolveType: "page",
      path: "/p/:slug",
      sections: [{ __resolveType: "site/sections/Text.tsx", text: "product" }],
    },
    Redirects: {
      __resolveType: "redirects",
      redirects: [{ from: "/shirts", to: "/p/shirt", permanent: true }],
    },
  };
}

/** The binding flow: routes, prefetch, redirects (a matching rule answers 302), resolve. */
async function page(cms: ReturnType<typeof createCMS>, path: string): Promise<string> {
  const c = cms.forRelease();
  const [routes] = await c.routes();
  const match = matchRoute(path, { routes: routes ?? [] });
  if (match.kind === "match") c.prefetch(match.entry.name);
  const [rules] = await c.redirects();
  const rule = (rules ?? []).find((r) => (r as { from?: string }).from === path);
  if (rule) return "302";
  if (match.kind !== "match") return "404";
  const [body, error] = await c.resolve<{ sections: { text: string }[] }>(match.entry.name);
  if (error) return `error: ${error.message}`;
  return body?.sections.map((s) => s.text).join(",") ?? "";
}

/** The worker's page cache on a HIT: only the cache key's revision, pinned on the page. */
async function cacheKey(cms: ReturnType<typeof createCMS>, path: string): Promise<string> {
  const c = cms.forRelease();
  const [routes] = await c.routes();
  const match = matchRoute(path, { routes: routes ?? [] });
  if (match.kind === "match") c.prefetch(match.entry.name);
  return c.revision();
}

/** `promise`'s value, or "hung" when it hasn't settled within `ms`. */
function within<T>(promise: Promise<T>, ms = 1000): Promise<T | "hung"> {
  return Promise.race([promise, new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);
}

describe("a prefetch whose request ended first", () => {
  it("a redirect: the next request that needs the prefetched page gets it", async () => {
    const api = fakeDelivery();
    await api.publish(site());
    const runtime = fakeRuntime(api, { waitUntil: true });
    const cms = createCMS({ blocks: blocks(), site: SITE });
    // The catch-all page answers after the redirect's request has answered.
    const release = api.hold(`blocks/${api.hashOf("catchAll")}.json`);
    expect(await runtime.serve(() => page(cms, "/shirts"))).toBe("302");
    release();
    expect(await within(runtime.serve(() => page(cms, "/nope")))).toBe("catch-all");
  });

  it("a page-cache HIT: the next miss on that page renders", async () => {
    const api = fakeDelivery();
    await api.publish(site());
    const runtime = fakeRuntime(api, { waitUntil: true });
    const cms = createCMS({ blocks: blocks(), site: SITE });
    await runtime.serve(() => page(cms, "/")); // warm: the index and the redirects block
    const release = api.hold(`blocks/${api.hashOf("product")}.json`);
    expect(await runtime.serve(() => cacheKey(cms, "/p/a"))).toMatch(/-/);
    release();
    expect(await within(runtime.serve(() => page(cms, "/p/b")))).toBe("product");
  });

  it("with nothing to keep it alive, the next request fails that block after the deadline, and the one after fetches again", async () => {
    const api = fakeDelivery();
    await api.publish(site());
    const runtime = fakeRuntime(api, { waitUntil: false });
    const cms = createCMS({ blocks: blocks(), site: SITE });
    const key = `blocks/${api.hashOf("catchAll")}.json`;
    const release = api.hold(key);
    expect(await runtime.serve(() => page(cms, "/shirts"))).toBe("302");
    release();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const second = runtime.serve(() => page(cms, "/nope"));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await second).toMatch(/^error: .*no answer within 11000 ms/);
    vi.useRealTimers();
    expect(await within(runtime.serve(() => page(cms, "/nope")))).toBe("catch-all");
    expect(api.keys().filter((k) => k === key)).toHaveLength(2);
  });
});

describe("a draft read whose request ended first", () => {
  it("another request sharing its release check gets the draft", async () => {
    const api = fakeDelivery();
    await api.publish(site());
    const studio = fakeStudio();
    const pointer = studio.draft({
      set: { Note: { __resolveType: "site/sections/Text.tsx", text: "draft" } },
    });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const runtime = fakeRuntime(
      {
        async fetch(input, init) {
          if (new URL(String(input)).pathname.includes("/drafts/")) {
            await held;
            return studio.fetch(input, init);
          }
          return api.fetch(input, init);
        },
      },
      { waitUntil: true },
    );
    const cms = createCMS({ blocks: blocks(), site: SITE });
    await runtime.serve(() => page(cms, "/"));
    const releaseCheck = await cms.checkRelease();
    // The first request starts the draft read and answers before it settles
    // (another part of it failed, its client went away).
    await runtime.serve(async () => {
      void cms
        .forDraft(pointer, { releaseCheck })
        .revision()
        .catch(() => {});
    });
    release();
    // The next request under the same check shares that read.
    const second = runtime.serve(async () => {
      const [note] = await cms
        .forDraft(pointer, { releaseCheck })
        .resolve<{ text: string }>("Note", { run: false });
      return note?.text;
    });
    expect(await within(second)).toBe("draft");
  });
});

describe("the block store's in-flight fetches", () => {
  /** A fetch per call that settles only when the test says so. */
  function controlled() {
    const calls: { hash: string; resolve: (body: unknown) => void }[] = [];
    const store = new BlockStore(
      (hash) =>
        new Promise((resolve) => {
          calls.push({ hash, resolve: (body) => resolve({ body, bytes: 1 }) });
        }),
      100,
      50,
    );
    return { store, calls };
  }

  it("a request joining a fetch that never settles fails with a timeout once its deadline passes", async () => {
    const { store, calls } = controlled();
    void store.get("h", "orphan").catch(() => {}); // its request goes away
    const joined = store.get("h", "orphan");
    await expect(joined).rejects.toBeInstanceOf(ContentUnavailableError);
    await expect(joined).rejects.toMatchObject({ reason: "timeout" });
    // Dropped from the map: the next read starts its own fetch.
    const again = store.get("h", "orphan");
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ ok: true });
    await expect(again).resolves.toEqual({ ok: true });
  });

  it("a fetch already past its deadline is dropped and fetched again at once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { store, calls } = controlled();
    void store.get("h", "orphan").catch(() => {});
    vi.setSystemTime(Date.now() + 60);
    const fresh = store.get("h", "orphan");
    expect(calls).toHaveLength(2);
    calls[1]!.resolve("body");
    await expect(fresh).resolves.toBe("body");
    // The late answer of the first fetch neither throws nor undoes anything.
    calls[0]!.resolve("late");
    expect(await store.get("h", "orphan")).toBe("body");
  });

  it("a request joining within the deadline shares the one fetch", async () => {
    const { store, calls } = controlled();
    const first = store.get("h", "n");
    const second = store.get("h", "n");
    expect(calls).toHaveLength(1);
    calls[0]!.resolve("body");
    await expect(Promise.all([first, second])).resolves.toEqual(["body", "body"]);
  });

  it("keeps each fetch it starts alive through the background hook", async () => {
    const kept: Promise<void>[] = [];
    (globalThis as Record<symbol, unknown>)[BACKGROUND_HOOK] = (task: () => Promise<void>) => {
      kept.push(task());
    };
    const { store, calls } = controlled();
    void store.get("h", "n");
    void store.get("h", "n");
    expect(kept).toHaveLength(1);
    calls[0]!.resolve("body");
    await expect(kept[0]).resolves.toBeUndefined();
  });
});
