// @vitest-environment node
/**
 * `createDecoWorker` over hosted releases (the content-addressed layout): the
 * worker's own reads (the redirects, the assignments, a draft's host check)
 * and a site's `pageCache` agree with the page on the index it pins, the
 * page's subtree goes out with the redirects block in one wave, and a preview
 * request reads its draft's folder once.
 */
import { type Blocks, matchRoute } from "@decocms/blocks";
import {
  cacheVersion,
  createDecoWorker,
  type PageCache,
  type ServerEntry,
} from "@decocms/tanstack/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "../packages/blocks/src/v8/cms";
import { fakeDelivery, fakeStudio, revisionId } from "../packages/blocks/src/v8/testFixtures";
import { MemoryCache, TestContext } from "../packages/tanstack/src/worker/testing";

const SITE = "acme";
const ORIGIN = "https://store.example.com";

/** A draft GET's URL without its cache-busting `?r=<nonce>` (see draftChanges.ts). */
const bare = (url: string) => url.replace(/\?r=[0-9a-z]+$/, "");

beforeEach(() => resetForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const blocks = { "site/sections/Text.tsx": (props: unknown) => props } as unknown as Blocks;

/** home → header, footer; another page; the redirects block. */
function site(title = "One"): Record<string, unknown> {
  return {
    home: {
      __resolveType: "page",
      path: "/",
      sections: [{ __resolveType: "header" }, { __resolveType: "footer" }],
    },
    shoes: { __resolveType: "page", path: "/shoes", sections: [] },
    header: { __resolveType: "site/sections/Text.tsx", text: title },
    footer: { __resolveType: "site/sections/Text.tsx", text: "footer" },
    Redirects: {
      __resolveType: "redirects",
      redirects: [{ from: "/old", to: "/", permanent: true }],
    },
  };
}

type Api = ReturnType<typeof fakeDelivery>;
const blockKey = (api: Api, name: string) => `blocks/${api.hashOf(name)}.json`;

/** The app: the binding flow on its own client, as `contentClient` builds it from the worker's headers. */
function app(cms: ReturnType<typeof createCMS>): ServerEntry {
  return {
    async fetch(request: Request) {
      const version = request.headers.get("x-deco-version");
      const releaseCheck = request.headers.get("x-deco-release-check");
      const c = cms.client(
        version === null ? {} : { version, ...(releaseCheck ? { releaseCheck } : {}) },
      );
      const [routes] = await c.routes();
      const match = matchRoute(new URL(request.url), { routes: routes ?? [] });
      if (match.kind === "match") c.prefetch(match.entry.name);
      await c.redirects();
      if (match.kind !== "match") return new Response("not found", { status: 404 });
      const [page] = await c.resolve<{ sections: { text?: string }[] }>(match.entry.name);
      const text = (page?.sections ?? []).map((s) => s.text).join(",");
      return new Response(`<p>${text}</p>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  };
}

/** A site cache keyed on the URL and `cacheVersion(cms, build, page.url)`. */
function siteCache(cms: ReturnType<typeof createCMS>) {
  const store = new MemoryCache();
  const pageCache: PageCache = async (page) => {
    const version = await cacheVersion(cms, "b1", page.url);
    const key = new Request(`${page.url.href}#${version}`);
    const hit = await store.match(key);
    const response = hit ?? (await page.render());
    if (!hit && response.status === 200) await store.put(key, response.clone());
    const out = new Response(response.body, response);
    out.headers.set("X-Cache", hit ? "HIT" : "MISS");
    return out;
  };
  return { store, pageCache };
}

describe("the worker on hosted releases", () => {
  it("a page rendered on the previous index is stored under that index's revision, never the new one", async () => {
    const api = fakeDelivery();
    vi.stubGlobal("fetch", api.fetch);
    await api.publish(site("One"));
    const cms = createCMS({ blocks, site: SITE });
    const { store, pageCache } = siteCache(cms);
    const worker = createDecoWorker({ serverEntry: app(cms), cms, pageCache });
    const ctx = new TestContext();
    expect(await (await worker.fetch(new Request(`${ORIGIN}/`), {}, ctx)).text()).toContain("One");

    // A new home (its header), the redirects block unchanged.
    await api.publish(site("Two"));
    expect(await cms.update()).toEqual({ updated: true });
    const release = api.hold(blockKey(api, "header"));
    const during = await worker.fetch(new Request(`${ORIGIN}/`), {}, ctx);
    expect(await during.text()).toContain("One"); // the previous index, while the new header loads
    expect(store.pageKeys().some((key) => key.includes(revisionId(2)))).toBe(false);
    expect(store.pageKeys().some((key) => key.includes(revisionId(1)))).toBe(true);

    release();
    // The new index lands in the background: the first request after it renders the new header.
    await vi.waitFor(
      async () => {
        const after = await worker.fetch(new Request(`${ORIGIN}/`), {}, ctx);
        expect(await after.text()).toContain("Two");
      },
      { timeout: 4_000, interval: 20 },
    );
    const fresh = store.pageKeys().filter((key) => key.includes(revisionId(2)));
    expect(fresh).toHaveLength(1);
    expect(await (await store.match(new Request(fresh[0] as string)))?.text()).toContain("Two");
    await ctx.settle();
  });

  it("the page's blocks go out with the redirects block, in one wave, before the app renders", async () => {
    const api = fakeDelivery();
    vi.stubGlobal("fetch", api.fetch);
    await api.publish(site());
    const cms = createCMS({ blocks, site: SITE });
    const worker = createDecoWorker({ serverEntry: app(cms), cms });
    const release = api.hold(blockKey(api, "Redirects"));
    const pending = worker.fetch(new Request(`${ORIGIN}/`), {}, new TestContext());
    // The redirects body is still on its way: the page's subtree was asked for beside it.
    await vi.waitFor(
      () => {
        const asked = api.keys();
        for (const name of ["home", "header", "footer"])
          expect(asked).toContain(blockKey(api, name));
      },
      { timeout: 4_000, interval: 20 },
    );
    release();
    const response = await pending;
    expect(await response.text()).toContain("One,footer");
    // Each body once: the app's wave found them by hash.
    for (const name of ["home", "header", "footer", "Redirects"]) {
      expect(api.keys().filter((key) => key === blockKey(api, name))).toHaveLength(1);
    }
  });

  it("a preview request reads its draft's folder once: the host check, the redirects, the assignments and the page share it", async () => {
    const api = fakeDelivery();
    const studio = fakeStudio();
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/drafts/") ? studio.fetch(input, init) : api.fetch(input, init),
    );
    await api.publish(site());
    const cms = createCMS({ blocks, site: SITE });
    const worker = createDecoWorker({ serverEntry: app(cms), cms });
    const pointer = studio.draft({
      set: { header: { __resolveType: "site/sections/Text.tsx", text: "Draft" } },
    });
    const url = `${ORIGIN}/?__draft=${encodeURIComponent(pointer)}`;
    const response = await worker.fetch(new Request(url), {}, new TestContext());
    expect(await response.text()).toContain("Draft,footer");
    const folder = (file: string) =>
      studio.requests.filter((r) => bare(r.url).endsWith(`/drafts/summer-sale/${file}`)).length;
    expect(folder("index.json")).toBe(1);
    expect(folder("header.json")).toBe(1);

    // The next preview request reads the draft again: nothing from drafts/ serves it.
    studio.draft({ set: { header: { __resolveType: "site/sections/Text.tsx", text: "Saved" } } });
    const next = await worker.fetch(new Request(url), {}, new TestContext());
    expect(await next.text()).toContain("Saved,footer");
    expect(folder("index.json")).toBe(2);
  });
});
