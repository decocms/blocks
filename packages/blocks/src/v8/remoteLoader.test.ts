// @vitest-environment node
/**
 * remoteLoader (hosted-releases-internals.mdx, hosted-publishing.mdx,
 * content-delivery.mdx, hosted-drafts.mdx): requests read memory, the
 * background check follows the channel manifest, drafts are fetched exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeContentRevision } from "../protocol/canonical";
import { createCMS, resetForTests } from "./cms";
import { remoteLoader } from "./remoteLoader";
import { docsBlocks, docsSnapshot } from "./testFixtures";
import type { Snapshot } from "./types";

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
      if (headers["if-none-match"] === `"g${manifest.generation}"`) {
        return new Response(null, { status: 304 });
      }
      return Response.json(manifest, { headers: { etag: `"g${manifest.generation}"` } });
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
  };
}

describe("remoteLoader: releases", () => {
  it("serves the fallback from memory until a release is fetched, with no network on load()", async () => {
    const api = deliveryApi();
    const fallback = docsSnapshot();
    const loader = remoteLoader(fallback, { site: SITE, token: TOKEN });
    expect(await loader.load()).toBe(fallback);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("asks for the manifest with the site token, fetches a new revision, verifies it and swaps it in whole", async () => {
    const api = deliveryApi();
    const release = await hashed("Published");
    api.publish(1, release);
    const loader = remoteLoader(docsSnapshot(), { site: SITE, token: TOKEN });

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
    const loader = remoteLoader(fallback, { site: SITE, token: TOKEN });

    expect(await loader.update?.()).toEqual({ updated: false });
    expect(api.requests.map((r) => r.url)).toEqual([MANIFEST_URL]);
    expect(await loader.load()).toBe(fallback);
  });

  it("sends the manifest ETag and treats 304 as nothing new", async () => {
    const api = deliveryApi();
    api.publish(1, await hashed("Published"));
    const loader = remoteLoader(docsSnapshot(), { site: SITE, token: TOKEN });
    await loader.update?.();
    expect(await loader.update?.()).toEqual({ updated: false });
    expect(api.requests.at(-1)?.headers["if-none-match"]).toBe('"g1"');
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
    const loader = remoteLoader(docsSnapshot(), { site: SITE, token: TOKEN });
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
    const loader = remoteLoader(docsSnapshot(), { site: SITE, token: TOKEN });

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
    const loader = remoteLoader(fallback, { site: SITE, token: TOKEN });
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
    const loader = remoteLoader(fallback, { site: SITE, token: TOKEN });
    expect(await loader.update?.()).toEqual({ updated: false });
    expect(await loader.load()).toBe(fallback);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("works over a fallback loader, reading it only to serve or compare it", async () => {
    deliveryApi();
    const fallback = await hashed("Bundled");
    const load = vi.fn(async () => fallback);
    const loader = remoteLoader({ load }, { site: SITE, token: TOKEN });
    expect(await loader.load()).toBe(fallback);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("remoteLoader: drafts", () => {
  it("fetches exactly the pointer's version from the delivery host, with the site token", async () => {
    const api = deliveryApi();
    const draft = await hashed("Draft");
    api.asset("/drafts/acme/feat", draft);
    const loader = remoteLoader(docsSnapshot(), { site: SITE, token: TOKEN });

    expect(await loader.load(`${HOST}/drafts/acme/feat?token=signed@9f3c1a`)).toEqual(draft);
    expect(api.requests[0]).toMatchObject({
      url: `https://${HOST}/drafts/acme/feat?token=signed`,
      headers: { authorization: `Bearer ${TOKEN}`, "if-match": "9f3c1a" },
    });
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

  it("loads drafts in development too", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const api = deliveryApi();
    const draft = await hashed("Draft");
    api.asset("/drafts/acme/feat", draft);
    const loader = remoteLoader(docsSnapshot(), { site: SITE, token: TOKEN });
    expect(await loader.load(`${HOST}/drafts/acme/feat@v1`)).toEqual(draft);
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
    const first = remoteLoader(fallback, { site: SITE, token: TOKEN });
    expect(remoteLoader(fallback, { site: SITE, token: TOKEN })).toBe(first);
    expect(remoteLoader(fallback, { site: SITE, token: TOKEN, interval: 120_000 })).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("interval"));
    expect(remoteLoader(fallback, { site: "other", token: TOKEN })).not.toBe(first);
  });

  it("createCMS paces a remoteLoader by its own interval when it has none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    deliveryApi();
    const loader = remoteLoader(docsSnapshot(), { site: SITE, token: TOKEN, interval: 300_000 });
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

  it("requires site and token", () => {
    expect(() => remoteLoader(docsSnapshot(), { site: "", token: TOKEN })).toThrow(TypeError);
  });
});
