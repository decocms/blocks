// @vitest-environment node
/**
 * remoteLoader (hosted-releases-internals.mdx, hosted-publishing.mdx,
 * content-delivery.mdx, hosted-drafts.mdx): requests read memory, the
 * background check follows the channel manifest, drafts are exact overlays
 * layered over the production content already in memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeContentRevision } from "./canonical";
import { createCMS, resetForTests } from "./cms";
import { remoteLoader } from "./remoteLoader";
import { docsBlocks, docsSnapshot, draftOverlayAssets } from "./testFixtures";
import type { Loader, Snapshot } from "./types";

/** With `site` and `token` set, `remoteLoader` returns a loader. */
const remote = (...args: Parameters<typeof remoteLoader>) => remoteLoader(...args);

const HOSTED_DELIVERY_ORIGIN = "https://delivery.decocms.com";
const SITE = "acme";
const TOKEN = "site-token";
const HOST = new URL(HOSTED_DELIVERY_ORIGIN).host;
const MANIFEST_URL = `${HOSTED_DELIVERY_ORIGIN}/sites/acme/channels/production.json`;

beforeEach(() => resetForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A snapshot whose revision is its real content hash, as the CLI and the Deco API compute it. */
async function hashed(title: string): Promise<Snapshot> {
  const blocks = {
    SummerSEO: { __resolveType: "seo", title, description: "d" },
  };
  return { revision: await computeContentRevision(blocks), blocks };
}

/** A fake delivery API: a channel manifest and immutable revision assets. */
function deliveryApi() {
  const assets = new Map<string, unknown>();
  let manifest: Record<string, unknown> | undefined;
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url, headers });
    if (url === MANIFEST_URL) {
      if (!manifest) return new Response("missing", { status: 404 });
      return Response.json(manifest);
    }
    const path = url.slice(HOSTED_DELIVERY_ORIGIN.length).split("?")[0] ?? "";
    if (assets.has(path)) return Response.json(assets.get(path));
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    requests,
    publish(generation: number, snapshot: Snapshot, body: unknown = snapshot) {
      const path = `/sites/acme/revisions/${snapshot.revision}.json`;
      assets.set(path, body);
      manifest = { format: 1, generation, revision: snapshot.revision, snapshot: path };
    },
    setManifest(value: Record<string, unknown>) {
      manifest = value;
    },
    asset(path: string, body: unknown) {
      assets.set(path, body);
    },
    remove(path: string) {
      assets.delete(path);
    },
    /** Prepares a draft overlay's assets; returns its pointer. */
    async draft(changes: { set?: Record<string, unknown>; delete?: string[] }) {
      const { version, assets: prepared } = await draftOverlayAssets(SITE, changes);
      for (const [path, body] of prepared) assets.set(path, body);
      return `${HOST}/sites/${SITE}/drafts?grant=signed@${version}`;
    },
  };
}

describe("remoteLoader: releases", () => {
  it("serves the fallback from memory until a release is fetched, with no network on load()", async () => {
    const api = deliveryApi();
    const fallback = docsSnapshot();
    const loader = remote(fallback, { site: SITE, token: TOKEN });
    expect(await loader.load()).toBe(fallback);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("asks for the manifest with the site token, fetches a new revision, verifies it and swaps it in whole", async () => {
    const api = deliveryApi();
    const release = await hashed("Published");
    api.publish(1, release);
    const loader = remote(docsSnapshot(), { site: SITE, token: TOKEN });

    expect(await loader.update?.()).toEqual({ updated: true });
    expect(await loader.load()).toEqual(release);
    expect(api.requests[0]).toMatchObject({
      url: MANIFEST_URL,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(api.requests[1]?.url).toBe(
      `${HOSTED_DELIVERY_ORIGIN}/sites/acme/revisions/${release.revision}.json`,
    );
  });

  it("uses the fallback without downloading when the release has the fallback's revision", async () => {
    const api = deliveryApi();
    const fallback = await hashed("Bundled");
    api.publish(1, fallback);
    const loader = remote(fallback, { site: SITE, token: TOKEN });

    expect(await loader.update?.()).toEqual({ updated: false });
    expect(api.requests.map((r) => r.url)).toEqual([MANIFEST_URL]);
    expect(await loader.load()).toBe(fallback);
  });

  it("retries a release whose download failed on the next check", async () => {
    const api = deliveryApi();
    const release = await hashed("Published");
    api.publish(1, release);
    const path = `/sites/acme/revisions/${release.revision}.json`;
    api.remove(path);
    const fallback = docsSnapshot();
    const loader = remote(fallback, { site: SITE, token: TOKEN });

    await expect(loader.update?.()).rejects.toThrow(/HTTP 404/);
    expect(await loader.load()).toBe(fallback);
    api.asset(path, release);
    expect(await loader.update?.()).toEqual({ updated: true });
    expect(await loader.load()).toEqual(release);
  });

  it("a fallback that can't load (a KV key the deploy never wrote) is fixed by a release check", async () => {
    const api = deliveryApi();
    const release = await hashed("Published");
    api.publish(1, release);
    const failing: Loader = { load: () => Promise.reject(new Error("no key")) };
    const loader = remote(failing, { site: SITE, token: TOKEN });

    await expect(loader.load()).rejects.toThrow("no key");
    expect(await loader.update?.()).toEqual({ updated: true });
    expect(await loader.load()).toEqual(release);
  });

  it("refuses content that doesn't hash to its revision, keeping memory as it was", async () => {
    const api = deliveryApi();
    const release = await hashed("Published");
    api.publish(1, release, { ...release, blocks: { Tampered: { __resolveType: "seo" } } });
    const fallback = docsSnapshot();
    const cms = createCMS({ blocks: docsBlocks(), content: fallback, site: SITE, token: TOKEN });

    expect(await cms.update()).toEqual({ updated: false });
    expect(await cms.forRelease().revision()).toBe(fallback.revision);
  });

  it("ignores a manifest with an unknown format or a snapshot path outside the site", async () => {
    const api = deliveryApi();
    const release = await hashed("Published");
    api.asset(`/sites/other/revisions/${release.revision}.json`, release);
    const loader = remote(docsSnapshot(), { site: SITE, token: TOKEN });
    const cms = createCMS({ blocks: docsBlocks(), content: loader });

    api.setManifest({
      format: 1,
      generation: 1,
      revision: release.revision,
      snapshot: `/sites/other/revisions/${release.revision}.json`,
    });
    expect(await cms.update()).toEqual({ updated: false });
    api.setManifest({
      format: 2,
      generation: 1,
      revision: release.revision,
      snapshot: `/sites/acme/revisions/${release.revision}.json`,
    });
    expect(await cms.update()).toEqual({ updated: false });
    expect(api.requests.every((r) => r.url === MANIFEST_URL)).toBe(true);
  });

  it("orders by generation: an older manifest is ignored, a newer one can roll back to an older revision", async () => {
    const api = deliveryApi();
    const a = await hashed("A");
    const b = await hashed("B");
    const loader = remote(docsSnapshot(), { site: SITE, token: TOKEN });

    api.publish(184, b);
    await loader.update?.();
    expect((await loader.load()).revision).toBe(b.revision);

    api.publish(183, a); // a delayed, older promotion
    expect(await loader.update?.()).toEqual({ updated: false });
    expect((await loader.load()).revision).toBe(b.revision);

    api.publish(185, a); // rollback: newer generation, older revision
    expect(await loader.update?.()).toEqual({ updated: true });
    expect((await loader.load()).revision).toBe(a.revision);
  });

  it("rolling back to the fallback's revision serves the fallback again", async () => {
    const api = deliveryApi();
    const fallback = await hashed("Bundled");
    const loader = remote(fallback, { site: SITE, token: TOKEN });
    api.publish(1, await hashed("Published"));
    await loader.update?.();
    api.publish(2, fallback);
    expect(await loader.update?.()).toEqual({ updated: true });
    expect(await loader.load()).toBe(fallback);
  });

  it("keeps local files in development: no release checks, the fallback is served", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const api = deliveryApi();
    api.publish(1, await hashed("Published"));
    const fallback = docsSnapshot();
    const loader = remote(fallback, { site: SITE, token: TOKEN });
    expect(await loader.update?.()).toEqual({ updated: false });
    expect(await loader.load()).toBe(fallback);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("works over a fallback loader, reading it only to serve or compare it", async () => {
    deliveryApi();
    const fallback = await hashed("Bundled");
    const load = vi.fn(async () => fallback);
    const loader = remote({ load }, { site: SITE, token: TOKEN });
    expect(await loader.load()).toBe(fallback);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("remoteLoader: drafts", () => {
  const entry = (title: string) => ({ __resolveType: "seo", title, description: "d" });

  it("fetches the overlay manifest, then its changed blocks, with the site token and the pointer's grant", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({ set: { SummerSEO: entry("Draft") } });
    const loader = remote(docsSnapshot(), { site: SITE, token: TOKEN });
    const view = await loader.load(pointer);
    expect(view.blocks.SummerSEO).toEqual(entry("Draft"));
    expect(api.requests).toHaveLength(2);
    expect(api.requests[0]!.url).toMatch(
      /\/sites\/acme\/drafts\/[0-9a-f]{64}\.json\?grant=signed$/,
    );
    expect(api.requests[1]!.url).toMatch(
      /\/sites\/acme\/draft-blocks\/[0-9a-f]{64}\.json\?grant=signed$/,
    );
    for (const r of api.requests) expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("layers over the newest release in memory, not the fallback", async () => {
    const api = deliveryApi();
    const release = await hashed("Published");
    api.publish(1, release);
    const loader = remote(docsSnapshot(), { site: SITE, token: TOKEN });
    await loader.update?.();
    const pointer = await api.draft({ set: { Extra: entry("New") } });
    const view = await loader.load(pointer);
    expect(Object.keys(view.blocks).sort()).toEqual(["Extra", "SummerSEO"]);
    expect(view.blocks.SummerSEO).toEqual(release.blocks.SummerSEO);
    expect(view.revision).toBe(`${release.revision}~${pointer.split("@")[1]}`);
  });

  it("concurrent loads of one draft share each download", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({ set: { SummerSEO: entry("Draft") } });
    const loader = remote(docsSnapshot(), { site: SITE, token: TOKEN });
    const [a, b] = await Promise.all([loader.load(pointer), loader.load(pointer)]);
    expect(a.blocks.SummerSEO).toEqual(b.blocks.SummerSEO);
    expect(api.requests).toHaveLength(2);
  });

  it("an entry named __proto__ stays an entry", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({ set: { ["__proto__"]: entry("Odd") } });
    const view = await remote(docsSnapshot(), { site: SITE, token: TOKEN }).load(pointer);
    expect(Object.hasOwn(view.blocks, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(view.blocks)).toBe(Object.prototype);
  });

  it("refuses a pointer to any other host without fetching (LOADER_FAILED)", async () => {
    const api = deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    const [value, error] = await cms.forDraft("evil.example/steal@v1").resolve("SummerSEO");
    expect(value).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("loads drafts in development too, over local files", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const api = deliveryApi();
    const pointer = await api.draft({ set: { SummerSEO: entry("Draft") } });
    const fallback = docsSnapshot();
    const view = await remote(fallback, { site: SITE, token: TOKEN }).load(pointer);
    expect(view.blocks.SummerSEO).toEqual(entry("Draft"));
    expect(view.blocks.HomePage).toBe(fallback.blocks.HomePage);
  });
});

describe("remoteLoader with createCMS", () => {
  it("site and token wrap the content: a check swaps the release in for the next client", async () => {
    const api = deliveryApi();
    const release = await hashed("Published");
    api.publish(1, release);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });

    const before = cms.forRelease();
    expect(await before.revision()).toBe("rev-1");
    expect(await cms.update()).toEqual({ updated: true });
    expect(await before.revision()).toBe("rev-1"); // a client keeps its revision
    const [seo] = await cms.forRelease().resolve<{ title: string }>("SummerSEO");
    expect(seo?.title).toBe("Published");
  });

  it("without both site and token, the content is read as is", async () => {
    const api = deliveryApi();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: SITE });
    expect(await cms.update()).toEqual({ updated: false });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("is one instance per process: the same site, token and fallback share it; another interval warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallback = docsSnapshot();
    const first = remote(fallback, { site: SITE, token: TOKEN });
    expect(remote(fallback, { site: SITE, token: TOKEN })).toBe(first);
    expect(remote(fallback, { site: SITE, token: TOKEN, interval: 120_000 })).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("interval"));
    expect(remote(fallback, { site: "other", token: TOKEN })).not.toBe(first);
  });

  it("createCMS paces a remoteLoader by its own interval when it has none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    deliveryApi();
    const loader = remote(docsSnapshot(), { site: SITE, token: TOKEN, interval: 300_000 });
    const update = vi.spyOn(loader, "update" as never);
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    cms.forRelease();
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.setSystemTime(new Date("2026-10-03T00:04:00Z"));
    cms.forRelease();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(update).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("is a loader over the fallback alone when site or token is unset", async () => {
    const fallback = docsSnapshot();
    for (const loader of [
      remoteLoader(fallback, { site: "", token: TOKEN }),
      remoteLoader(fallback, { site: SITE }),
    ]) {
      expect(await loader.load()).toBe(fallback);
      expect(loader.update).toBeUndefined();
    }
  });
});
