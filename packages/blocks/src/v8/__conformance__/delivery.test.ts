// @vitest-environment node
/**
 * Docs conformance: content-delivery, draft-synchronization,
 * releases-and-deployment, hosted, hosted-publishing, hosted-drafts and
 * hosted-releases-internals (src/content/docs/en/storefront/blocks/next/*.mdx in
 * deco-sites/docs-tanstack), as the hosted contract (2026-10-06) defines them:
 * `sites/<site>/latest.json` and `revisions/<sha>.json` on delivery.decocms.com,
 * drafts on the CDN. Each test names the claim it checks (CD-*, RD-*, H-*, HP-*,
 * HD-*, HRI-*, DP-*). A failing test is a claim the code doesn't meet yet.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as root from "../../index";
import { computeContentRevision, sha256Hex } from "../../protocol/canonical";
import { HOSTED_ANALYTICS_COLLECTOR } from "../builtins/data";
import { instanceOf } from "../cms";
import {
  createCMS,
  formatDraftPointer,
  matchRoute,
  parseDraftPointer,
  remoteLoader,
  resetForTests,
} from "../index";
import { resolveDestination } from "../telemetry";
import {
  DRAFT_HOST,
  docsBlocks,
  fakeStudio,
  docsSnapshot as unhashedSnapshot,
} from "../testFixtures";
import type { Loader, RequestLike, Snapshot } from "../types";

/** cms.draftPointer and cms.draftCookie on a CMS with no settings: every host may preview. */
const helpers = () => createCMS({ blocks: {}, content: { revision: "draft-helpers", blocks: {} } });
const draftPointer = (request: RequestLike) => helpers().draftPointer(request);
const draftCookie = (request: RequestLike) => helpers().draftCookie(request);
const DRAFT_COOKIE = "__deco_draft";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://delivery.decocms.com";
const SITE = "acme";
const TOKEN = "site-token";
const LATEST_URL = `${ORIGIN}/sites/acme/latest.json`;
/** The schemaHash of the schema the deployed code was built with (`deco content` writes it). */
const SCHEMA = "5".repeat(64);
/** A pointer string, for the cookie and parsing claims; drafts that load come from api.draft(). */
const POINTER = `${DRAFT_HOST}/sites/acme/drafts/summer-sale.json@9f3c1a`;
/** Where the fake CDN answers drafts. */
const DRAFTS = `https://${DRAFT_HOST}/sites/acme/drafts/`;

/** The bundled content module: the docs' snapshot, built with the deployed schema. */
const docsSnapshot = (revision?: string): Snapshot => ({
  ...unhashedSnapshot(revision),
  schemaHash: SCHEMA,
});

const remote = (fallback: Snapshot | Loader) => remoteLoader(fallback, { site: SITE }) as Loader;
const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => resetForTests());
afterEach(async () => {
  await flush(); // let background checks a test started finish against its own fetch stub
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetForTests();
});

/** A release as Studio publishes it for a commit: the blocks at that commit, keyed by its SHA. */
async function hashed(title: string, extra: Record<string, unknown> = {}): Promise<Snapshot> {
  const blocks = { SummerSEO: { __resolveType: "seo", title, description: "d" }, ...extra };
  return { revision: (await sha256Hex(title)).slice(0, 40), blocks };
}

/** A content module whose revision is its real content hash, as `deco content` writes it. */
async function contentModule(): Promise<Snapshot> {
  const snapshot = docsSnapshot();
  return { ...snapshot, revision: await computeContentRevision(snapshot.blocks) };
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A saved seo entry, as a draft changes it. */
const seoEntry = (title: string) => ({ __resolveType: "seo", title, description: "d" });

/**
 * A fake delivery CDN: `sites/acme/latest.json`, immutable
 * `sites/acme/revisions/<sha>.json`, and drafts (see testFixtures' fakeStudio).
 */
function deliveryApi() {
  const drafts = fakeStudio();
  const objects = new Map<string, unknown>();
  const gates = new Map<string, Deferred>();
  let failAll = false;
  const requests: { url: string; headers: Record<string, string>; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url, headers, init });
    if (failAll) throw new TypeError("fetch failed");
    await gates.get(new URL(url).pathname)?.promise;
    if (url.startsWith(DRAFTS)) return drafts.fetch(url, init);
    if (!url.startsWith(ORIGIN)) return new Response("wrong host", { status: 599 });
    const p = url.slice(ORIGIN.length).split("?")[0] ?? "";
    if (objects.has(p)) {
      const body = objects.get(p);
      if (body instanceof Response) return body;
      return Response.json(body);
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  const latest = (revision: string, schemaHash = SCHEMA) => ({
    revision,
    schemaHash,
    publishedAt: new Date().toISOString(),
  });
  return {
    fetch,
    requests,
    assetPath: (revision: string) => `/sites/acme/revisions/${revision}.json`,
    /** Studio's publish: `revisions/<sha>.json`, then `latest.json` naming it. */
    publish(snapshot: Snapshot, body?: unknown, schemaHash = SCHEMA) {
      objects.set(
        `/sites/acme/revisions/${snapshot.revision}.json`,
        body ?? { revision: snapshot.revision, schemaHash, blocks: snapshot.blocks },
      );
      objects.set("/sites/acme/latest.json", latest(snapshot.revision, schemaHash));
    },
    /** Studio's "Make current" (or a pointer to a revision that isn't there): `latest.json` only. */
    point(revision: string, schemaHash = SCHEMA) {
      objects.set("/sites/acme/latest.json", latest(revision, schemaHash));
    },
    setLatest(value: unknown) {
      objects.set("/sites/acme/latest.json", value);
    },
    asset(p: string, body: unknown) {
      objects.set(p, body);
    },
    /** Saves a draft on the fake CDN; returns the pointer Studio would hand out. */
    draft: drafts.draft,
    /** Answers a draft with this response instead. */
    respond: drafts.respond,
    draftFetches: () => requests.filter((r) => r.url.startsWith(DRAFTS)),
    gate(p: string) {
      const d = deferred();
      gates.set(p, d);
      return d;
    },
    fail(value: boolean) {
      failAll = value;
    },
    assetFetches: () => requests.filter((r) => r.url.includes("/revisions/")).length,
    latestFetches: () => requests.filter((r) => r.url === LATEST_URL).length,
  };
}

const titleOf = async (client: ReturnType<ReturnType<typeof createCMS>["forRelease"]>) => {
  const [entry, error] = await client.resolve<{ title: string }>("SummerSEO", { run: false });
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return entry.title;
};

// ---------------------------------------------------------------------------
// content-delivery.mdx
// ---------------------------------------------------------------------------

describe("content-delivery", () => {
  it("CD-1: the SDK never calls GitHub; releases come from the delivery origin, drafts from the pointer's host", async () => {
    for (const file of ["../remoteLoader.ts", "../draftChanges.ts", "../content.ts", "../cms.ts"]) {
      expect(fs.readFileSync(path.join(HERE, file), "utf8")).not.toMatch(/github/i);
    }
    const api = deliveryApi();
    api.publish(await hashed("Published"));
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: SITE });
    await cms.update();
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    const urls = api.requests.map((r) => r.url);
    expect(urls.filter((url) => url.startsWith(DRAFTS))).toHaveLength(1);
    expect(urls.filter((url) => url.startsWith(`${ORIGIN}/`) && !url.startsWith(DRAFTS))).toEqual([
      LATEST_URL,
      expect.stringMatching(/\/sites\/acme\/revisions\/[0-9a-f]{40}\.json$/),
    ]);
    expect(urls).toHaveLength(3);
  });

  it("CD-3: the bundled module's revision is the canonical content hash; a release's is its commit SHA", async () => {
    const a = { A: { __resolveType: "seo", x: 1, y: 2 }, B: { z: [1, 2] } };
    const b = { B: { z: [1, 2] }, A: { y: 2, __resolveType: "seo", x: 1 } };
    expect(await computeContentRevision(a)).toBe(await computeContentRevision(b));
    const cli = fs.readFileSync(path.join(HERE, "../cli/content.ts"), "utf8");
    expect(cli).toMatch(
      /import \{[^}]*\bcomputeContentRevision\b[^}]*\} from "[./]+(protocol\/)?canonical\.ts"/,
    );
    // No content-hash verification of releases: the SDK never hashes what it downloads.
    const sdk = fs.readFileSync(path.join(HERE, "../remoteLoader.ts"), "utf8");
    expect(sdk).not.toMatch(/computeContentRevision|sha256/);
  });

  it("CD-4/CD-5/CD-6: reads /sites/<site>/latest.json and the { revision, schemaHash, blocks } it names", async () => {
    const api = deliveryApi();
    const release = await hashed("Commit C");
    // The docs' examples: latest.json and the revision object Studio writes for commit C.
    api.setLatest({
      revision: release.revision,
      schemaHash: SCHEMA,
      publishedAt: "2026-10-06T12:00:00.000Z",
    });
    api.asset(`/sites/acme/revisions/${release.revision}.json`, {
      revision: release.revision,
      schemaHash: SCHEMA,
      blocks: release.blocks,
    });
    const fallback = docsSnapshot();
    const loader = remote(fallback);
    expect(await loader.update?.()).toEqual({ updated: true });
    expect(api.requests.map((r) => r.url)).toEqual([
      LATEST_URL,
      `${ORIGIN}/sites/acme/revisions/${release.revision}.json`,
    ]);
    expect(api.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
    const loaded = await loader.load();
    expect(loaded).toEqual({
      revision: release.revision,
      schemaHash: SCHEMA,
      blocks: release.blocks,
      aliases: fallback.aliases,
    });
  });

  it("CD-7: refuses a latest.json that isn't { revision: <commit SHA>, schemaHash, publishedAt }", async () => {
    const release = await hashed("Evil");
    const bad = [
      { revision: release.revision, schemaHash: SCHEMA }, // no publishedAt
      { revision: "../../other/revisions/x", schemaHash: SCHEMA, publishedAt: "x" },
      { revision: `${release.revision}/../x`, schemaHash: SCHEMA, publishedAt: "x" },
      { revision: "f".repeat(64), schemaHash: SCHEMA, publishedAt: "x" }, // a content hash
      { revision: release.revision, schemaHash: "x", publishedAt: "x" },
      { format: 1, generation: 1, revision: release.revision, snapshot: "/x.json" }, // v0 channels
    ];
    for (const value of bad) {
      resetForTests();
      const api = deliveryApi();
      api.asset(api.assetPath(release.revision), {
        revision: release.revision,
        schemaHash: SCHEMA,
        blocks: release.blocks,
      });
      api.setLatest(value);
      const fallback = docsSnapshot();
      const loader = remote(fallback);
      await expect(loader.update?.()).rejects.toThrow();
      expect(api.assetFetches()).toBe(0);
      expect(await loader.load()).toBe(fallback);
    }
  });

  it("CD-8: swaps only when latest.json's schemaHash equals the bundled content's; otherwise keeps what it serves", async () => {
    const api = deliveryApi();
    const one = await hashed("One");
    const two = await hashed("Two");
    const fallback = docsSnapshot();
    const cms = createCMS({ blocks: docsBlocks(), content: fallback, site: SITE });
    api.publish(one, undefined, "6".repeat(64));
    expect(await cms.update()).toEqual({ updated: false });
    expect(api.assetFetches()).toBe(0);
    expect(await cms.forRelease().revision()).toBe(fallback.revision);
    api.publish(one);
    expect(await cms.update()).toEqual({ updated: true });
    api.publish(two, undefined, "6".repeat(64));
    expect(await cms.update()).toEqual({ updated: false });
    expect(await titleOf(cms.forRelease())).toBe("One");
  });

  it("CD-9: bundled content without a schemaHash (no schema.gen.json at build) never swaps", async () => {
    const api = deliveryApi();
    api.publish(await hashed("Published"));
    const cms = createCMS({ blocks: docsBlocks(), content: unhashedSnapshot(), site: SITE });
    expect(await cms.update()).toEqual({ updated: false });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("CD-10: no comparison with the bundle: the first check downloads the pointer's revision even when it holds the bundled content", async () => {
    const api = deliveryApi();
    const bundled = docsSnapshot();
    const sameContent = { revision: "c".repeat(40), blocks: bundled.blocks };
    api.publish(sameContent);
    const cms = createCMS({ blocks: docsBlocks(), content: bundled, site: SITE });
    expect(await cms.update()).toEqual({ updated: true });
    expect(api.assetFetches()).toBe(1);
    expect(await cms.forRelease().revision()).toBe(sameContent.revision);
    expect(await cms.update()).toEqual({ updated: false }); // the revision it already loaded
    expect(api.assetFetches()).toBe(1);
  });

  it("CD-11: a missing or failing asset keeps the last good content", async () => {
    const api = deliveryApi();
    const good = await hashed("Good");
    api.publish(good);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    await cms.update();
    expect(await titleOf(cms.forRelease())).toBe("Good");
    const missing = await hashed("Missing");
    api.point(missing.revision); // 404
    await expect(cms.update()).resolves.toEqual({ updated: false });
    api.asset(api.assetPath(missing.revision), new Response("boom", { status: 500 }));
    await expect(cms.update()).resolves.toEqual({ updated: false });
    expect(await titleOf(cms.forRelease())).toBe("Good");
  });

  it('CD-12: a rollback (Studio\'s "Make current" pointing latest.json at an older revision) is adopted', async () => {
    const api = deliveryApi();
    const a = await hashed("A");
    const b = await hashed("B");
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: SITE });
    api.publish(a);
    await cms.update();
    api.publish(b);
    await cms.update();
    expect(await titleOf(cms.forRelease())).toBe("B");
    api.point(a.revision);
    expect(await cms.update()).toEqual({ updated: true });
    expect(await titleOf(cms.forRelease())).toBe("A");
  });

  it("CD-16: the SDK bounds the snapshot size it accepts (stops reading an oversized asset)", async () => {
    const api = deliveryApi();
    const CHUNK = new Uint8Array(1024 * 1024).fill(0x20); // JSON whitespace
    const TOTAL_MB = 192; // over a Worker isolate's whole 128 MB
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 0) controller.enqueue(new TextEncoder().encode("["));
        if (pulled >= TOTAL_MB) return controller.close();
        pulled++;
        controller.enqueue(CHUNK);
      },
    });
    const revision = "f".repeat(40);
    api.point(revision);
    api.asset(api.assetPath(revision), new Response(body));
    const fallback = docsSnapshot();
    const loader = remote(fallback);
    await expect(loader.update?.()).rejects.toThrow();
    expect(await loader.load()).toBe(fallback);
    // Rejected by a size bound, not after buffering and failing to parse all of it.
    expect(pulled).toBeLessThan(TOTAL_MB);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// content-delivery.mdx#draft-previews, hosted-drafts.mdx#who-may-preview:
// a draft pointer names Studio's API, which answers only the changes
// ---------------------------------------------------------------------------

/** A body that streams `mb` MiB of JSON whitespace after `[`, counting what was pulled. */
function hugeBody(mb: number) {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === 0) controller.enqueue(new TextEncoder().encode("["));
      if (state.pulled >= mb) return controller.close();
      state.pulled++;
      controller.enqueue(chunk);
    },
  });
  return { body, state };
}

describe("draft previews", () => {
  const cmsOf = (options: Partial<Parameters<typeof createCMS>[0]> = {}) =>
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), ...options });
  const failed = async (client: ReturnType<ReturnType<typeof createCMS>["forDraft"]>) => {
    const [value, error] = await client.resolve("SummerSEO");
    const [list, listError] = await client.list("seo");
    return { value, code: error?.code, list, listCode: listError?.code };
  };
  const FAILED = { value: null, code: "LOADER_FAILED", list: null, listCode: "LOADER_FAILED" };

  it("DP-1: GET https://<host><path>?v=<version>: forced variants removed, no cookies or credentials", async () => {
    const api = deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const withVariant = formatDraftPointer({
      ...parseDraftPointer(pointer)!,
      variants: [{ block: "Home", path: "", index: 1 }],
    });
    const cms = cmsOf({ site: SITE, token: TOKEN });
    expect(await titleOf(cms.forDraft(withVariant))).toBe("Draft");
    const [request, ...more] = api.draftFetches();
    expect(more).toEqual([]);
    expect(request!.url).toBe(`${DRAFTS}summer-sale.json?v=9f3c1a`);
    expect(request!.headers).not.toHaveProperty("cookie");
    expect(request!.headers).not.toHaveProperty("authorization"); // never the site token
    expect(request!.init?.credentials).not.toBe("include");
    expect(request!.init?.redirect).toBe("manual");
  });

  it("DP-2: set replaces production's block whole, delete removes it, every other block is production's", async () => {
    const api = deliveryApi();
    const production = docsSnapshot();
    const before = JSON.stringify(production);
    const pointer = api.draft({
      set: {
        SummerSEO: { __resolveType: "seo", title: "Draft" }, // no description: never merged
        NewPost: { __resolveType: "post", name: "New", path: "/blog/new", date: "2026-10-01" },
      },
      delete: ["HelloWorld", "LegacySummer"],
    });
    const draft = cmsOf({ content: production }).forDraft(pointer);
    expect(await draft.resolve("SummerSEO", { run: false })).toEqual([
      { __resolveType: "seo", title: "Draft" },
      null,
    ]);
    expect((await draft.resolve("HelloWorld"))[1]?.code).toBe("NOT_FOUND");
    expect((await draft.resolve("LegacySummer"))[1]?.code).toBe("NOT_FOUND");
    const [card] = await draft.resolve("SummerCard", { run: false });
    expect(card).toEqual({
      __resolveType: "product-card",
      title: "Summer collection",
      product: { __resolveType: "catalog-product", slug: "summer-shirt" },
    });
    // list: production's names plus set's, minus delete.
    const [posts] = await draft.list<{ name: string }>("post");
    expect(posts?.map((post) => post.name)).toEqual(["New"]);
    expect(await draft.list("redirect")).toEqual([[], null]);
    const [pages] = await draft.list<{ name: string }>("page");
    expect(pages?.map((page) => page.name).sort()).toEqual(["Home", "Summer campaign"]);
    expect(JSON.stringify(production)).toBe(before); // never mutated
  });

  it("DP-3: a client captures production once; the next client gets the new release and fetches the draft again", async () => {
    const api = deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = cmsOf({ site: SITE });
    const first = cms.forDraft(pointer);
    expect(await titleOf(first)).toBe("Draft");
    api.publish(
      await hashed("Published", {
        HelloWorld: { __resolveType: "post", name: "Republished", path: "/x", date: "2026-10-02" },
      }),
    );
    await cms.update();
    const [oldPosts] = await first.list<{ name: string }>("post");
    expect(oldPosts?.map((p) => p.name)).toEqual(["Hello, world"]); // its captured base
    const next = cms.forDraft(pointer);
    expect(await titleOf(next)).toBe("Draft");
    const [newPosts] = await next.list<{ name: string }>("post");
    expect(newPosts?.map((p) => p.name)).toEqual(["Republished"]);
    expect(api.draftFetches()).toHaveLength(2); // dropped when the release changed
    expect(await next.revision()).not.toBe(await first.revision());
  });

  it("DP-4: the draft's revision is an opaque identity of the production revision and the version", async () => {
    const api = deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const draft = cmsOf().forDraft(pointer);
    const revision = await draft.revision();
    expect(revision).toContain("rev-1");
    expect(revision).toContain('"etag-1"'); // the draft body's ETag: the pointer outlives saves
    expect(revision).not.toBe("rev-1");
    api.draft({ set: { SummerSEO: seoEntry("Saved again") } });
    const saved = cmsOf().forDraft(pointer);
    expect(await titleOf(saved)).toBe("Saved again");
    expect(await saved.revision()).not.toBe(revision);
  });

  it("DP-5: only *.decocms.com and loopback hosts by default; any other host, or a look-alike, is refused before anything is fetched", async () => {
    const api = deliveryApi();
    const cms = cmsOf();
    const changes = "/sites/acme/drafts/summer-sale.json";
    for (const pointer of [
      `evil.example${changes}@1`,
      `studio.decocms.com.evil.example${changes}@1`,
      `evil.example/studio.decocms.com${changes}@1`,
      `evil-decocms.com${changes}@1`,
      `decocms.com${changes}@1`,
      `studio.decocms.com:8443${changes}@1`,
      `169.254.169.254/latest/meta-data?x=1@1`,
      `studio.decocms.com@evil.example${changes}@1`,
      `https://studio.decocms.com${changes}@1`,
      `studio.decocms.com//evil.example/x@1`,
      `studio.decocms.com\\@evil.example/x@1`,
    ]) {
      expect({ pointer, ...(await failed(cms.forDraft(pointer))) }).toEqual({ pointer, ...FAILED });
    }
    expect(api.fetch).not.toHaveBeenCalled();
    // The host is compared lowercase, so an uppercase pointer still reaches the CDN.
    const upper = api
      .draft({ set: { SummerSEO: seoEntry("Draft") } })
      .replace(DRAFT_HOST, DRAFT_HOST.toUpperCase());
    expect(await titleOf(cms.forDraft(upper))).toBe("Draft");
  });

  it("DP-6: createCMS({ preview: { draftHosts } }) replaces the default list; no environment variable does; content can't widen it", async () => {
    const api = deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    expect(
      await failed(cmsOf({ preview: { draftHosts: ["studio.example.com"] } }).forDraft(pointer)),
    ).toEqual(FAILED);
    expect(api.fetch).not.toHaveBeenCalled();
    resetForTests();
    const both = cmsOf({ preview: { draftHosts: [" .decocms.com ", "studio.example.com"] } });
    expect(await titleOf(both.forDraft(pointer))).toBe("Draft");
    // DECO_PREVIEW_API_DOMAINS (v7's variable) is read by the site, if at all, never by the SDK.
    resetForTests();
    vi.stubEnv("DECO_PREVIEW_API_DOMAINS", "studio.example.com");
    expect(await titleOf(cmsOf().forDraft(pointer))).toBe("Draft");
    vi.unstubAllEnvs();
    // Content can't widen it: the CMS block has no say over where drafts come from.
    resetForTests();
    const release = docsSnapshot();
    release.blocks.CMS = { __resolveType: "cms-settings", preview: { hosts: ["*"] } };
    const fromContent = cmsOf({ content: release });
    expect(await failed(fromContent.forDraft("evil.example/sites/acme/drafts/x.json@1"))).toEqual(
      FAILED,
    );
    expect(api.requests.filter((r) => r.url.includes("evil.example"))).toEqual([]);
  });

  it("DP-7: HTTPS, except plain HTTP for localhost, *.localhost and 127.0.0.1; a port only on those and local.studio.decocms.com; [::1] only when configured", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        return Response.json({ set: {}, delete: [] });
      }),
    );
    const cms = cmsOf();
    for (const host of [
      "localhost:4000",
      "studio.localhost",
      "127.0.0.1:4000",
      "local.studio.decocms.com:4000",
      "studio.decocms.com",
      "pr-12.pr.studio.decocms.com",
    ]) {
      expect((await cms.forDraft(`${host}/changes?token=t@v1`).revision()).endsWith("~v1")).toBe(
        true,
      );
    }
    expect(urls).toEqual([
      "http://localhost:4000/changes?token=t&v=v1",
      "http://studio.localhost/changes?token=t&v=v1",
      "http://127.0.0.1:4000/changes?token=t&v=v1",
      "https://local.studio.decocms.com:4000/changes?token=t&v=v1",
      "https://studio.decocms.com/changes?token=t&v=v1",
      "https://pr-12.pr.studio.decocms.com/changes?token=t&v=v1",
    ]);

    // The defaults are v7's, which never listed the IPv6 loopback.
    urls.length = 0;
    expect(await failed(cms.forDraft("[::1]:4000/changes?token=t@v2"))).toEqual(FAILED);
    expect(urls).toEqual([]);
    // Configured, it is a loopback domain like the others: plain HTTP, any port.
    resetForTests();
    expect(
      (
        await cmsOf({ preview: { draftHosts: ["[::1]"] } })
          .forDraft("[::1]:4000/changes?token=t@v3")
          .revision()
      ).endsWith("~v3"),
    ).toBe(true);
    expect(urls).toEqual(["http://[::1]:4000/changes?token=t&v=v3"]);
  });

  it("DP-8: only a 200 (or a 304 to the ETag it sent) is accepted: an error status, or a redirect, is a failed draft", async () => {
    for (const status of [201, 204, 301, 302, 400, 401, 403, 404, 413, 500, 502]) {
      resetForTests();
      const api = deliveryApi();
      const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
      api.respond("summer-sale", () =>
        status === 204
          ? new Response(null, { status })
          : new Response(JSON.stringify({ set: {}, delete: [] }), {
              status,
              headers: status >= 300 && status < 400 ? { location: "https://evil.example/" } : {},
            }),
      );
      const cms = cmsOf();
      await cms.forRelease().revision();
      expect({ status, ...(await failed(cms.forDraft(pointer))) }).toEqual({ status, ...FAILED });
      expect(api.requests.filter((r) => r.url.includes("evil.example"))).toEqual([]);
    }
  });

  it("DP-9: a response over 16 MiB is refused while it downloads", async () => {
    const api = deliveryApi();
    const pointer = api.draft({});
    const { body, state } = hugeBody(64);
    api.respond("summer-sale", () => new Response(body));
    expect(await failed(cmsOf().forDraft(pointer))).toEqual(FAILED);
    expect(state.pulled).toBeLessThanOrEqual(18);
    // A declared length over the limit isn't read at all.
    resetForTests();
    const declared = deliveryApi();
    const big = declared.draft({});
    const huge = hugeBody(64);
    declared.respond(
      "summer-sale",
      () => new Response(huge.body, { headers: { "content-length": String(17 * 1024 * 1024) } }),
    );
    expect(await failed(cmsOf().forDraft(big))).toEqual(FAILED);
    expect(huge.state.pulled).toBeLessThanOrEqual(1);
  }, 60_000);

  it("DP-10: a response that doesn't arrive within 10 seconds is a failed draft", async () => {
    const timeouts: number[] = [];
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return controller.signal;
    });
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            started();
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const client = cmsOf().forDraft(POINTER);
    const result = failed(client);
    await fetching;
    expect(timeouts).toEqual([10_000]);
    controller.abort(new DOMException("timed out", "TimeoutError"));
    expect(await result).toEqual(FAILED);
  });

  it("DP-11: the shape is checked: exactly { set, delete }, disjoint", async () => {
    const bodies: unknown[] = [
      { format: 1, set: {}, delete: [] }, // the old git-branch form
      { set: {}, delete: [], baseRevision: "x" },
      { set: [], delete: [] },
      { set: null, delete: [] },
      { set: {} },
      { delete: [] },
      { set: {}, delete: "HelloWorld" },
      { set: {}, delete: [1] },
      { set: { A: seoEntry("x") }, delete: ["A"] },
      [{ set: {}, delete: [] }],
      "changes",
      null,
    ];
    for (const body of [...bodies, "not json"]) {
      resetForTests();
      const api = deliveryApi();
      const pointer = api.draft({});
      api.respond("summer-sale", () =>
        body === "not json" ? new Response("{oops") : Response.json(body),
      );
      expect({ body, ...(await failed(cmsOf().forDraft(pointer))) }).toEqual({ body, ...FAILED });
    }
  });

  it("DP-12: a failed draft is LOADER_FAILED on every call, never published content, and isn't reused", async () => {
    const api = deliveryApi();
    api.publish(await hashed("Release"));
    const cms = cmsOf({ site: SITE });
    await cms.update();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    api.respond("summer-sale", () => new Response("bad gateway", { status: 502 }));
    const client = cms.forDraft(pointer);
    expect(await failed(client)).toEqual(FAILED);
    await expect(client.revision()).rejects.toMatchObject({ code: "LOADER_FAILED" });
    const [, error] = await client.resolve("SummerSEO");
    expect(String((error?.cause as Error | undefined)?.message)).toContain("HTTP 502");
    api.respond("summer-sale", () =>
      Response.json({ set: { SummerSEO: seoEntry("Back") }, delete: [] }),
    );
    expect(await titleOf(cms.forDraft(pointer))).toBe("Back");
    expect(api.draftFetches()).toHaveLength(2);
  });

  it("DP-13: a draft that isn't there (a wrong or deleted slug) gets no content", async () => {
    const api = deliveryApi();
    api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const wrong = `${DRAFT_HOST}/sites/acme/drafts/guessed.json@9f3c1a`;
    expect(await failed(cmsOf().forDraft(wrong))).toEqual(FAILED);
    expect(api.draftFetches()).toHaveLength(1);
  });

  it("DP-14: every read revalidates with If-None-Match; a 304 reuses the body; at most three bodies per CMS", async () => {
    const api = deliveryApi();
    const pointer = (slug: string) => api.draft({ set: { SummerSEO: seoEntry(slug) } }, { slug });
    const cms = cmsOf();
    const a = pointer("a");
    expect(await titleOf(cms.forDraft(a))).toBe("a");
    expect(api.draftFetches()[0]?.headers["if-none-match"]).toBeUndefined();
    expect(await titleOf(cms.forDraft(a))).toBe("a");
    expect(api.draftFetches()).toHaveLength(2);
    expect(api.draftFetches()[1]?.headers["if-none-match"]).toBe('"etag-1"');
    expect((await api.fetch.mock.results.at(-1)?.value)?.status).toBe(304);
    // A save gives the object a new ETag: the next read gets the new body (a 200).
    api.draft({ set: { SummerSEO: seoEntry("a, saved") } }, { slug: "a" });
    expect(await titleOf(cms.forDraft(a))).toBe("a, saved");
    expect((await api.fetch.mock.results.at(-1)?.value)?.status).toBe(200);
    for (const slug of ["b", "c", "d"]) await titleOf(cms.forDraft(pointer(slug)));
    await titleOf(cms.forDraft(a)); // the fourth evicted the oldest: no ETag to send
    expect(api.draftFetches().at(-1)?.headers["if-none-match"]).toBeUndefined();
    await titleOf(cms.forDraft(`${DRAFT_HOST}/sites/acme/drafts/d.json@9f3c1a`));
    expect(api.draftFetches().at(-1)?.headers["if-none-match"]).toBeDefined();
  });

  it("DP-14b: a 304 to a request that sent no ETag is a failed draft", async () => {
    const api = deliveryApi();
    const pointer = api.draft({});
    api.respond("summer-sale", () => new Response(null, { status: 304 }));
    expect(await failed(cmsOf().forDraft(pointer))).toEqual(FAILED);
  });

  it("DP-15: drafts need no site or token, and never send them", async () => {
    const api = deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    expect(await titleOf(cmsOf().forDraft(pointer))).toBe("Draft");
    expect(api.requests.map((r) => new URL(r.url).host)).toEqual([DRAFT_HOST]);
    resetForTests();
    const hosted = deliveryApi();
    const hostedPointer = hosted.draft({ set: { SummerSEO: seoEntry("Draft") } });
    expect(await titleOf(cmsOf({ site: SITE, token: TOKEN }).forDraft(hostedPointer))).toBe(
      "Draft",
    );
    for (const r of hosted.draftFetches()) expect(r.headers.authorization).toBeUndefined();
  });

  it("DP-16: a pointer whose version is local names no draft: nothing is fetched, forced variants apply", async () => {
    const api = deliveryApi();
    const content = docsSnapshot();
    content.blocks.Banner = {
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "always" }, value: "spring" },
        { rule: { __resolveType: "never" }, value: "summer" },
      ],
    };
    const cms = cmsOf({ content });
    const local = formatDraftPointer({
      host: "localhost:4547",
      path: "/",
      version: "local",
      variants: [{ block: "Banner", path: "", index: 1 }],
    });
    expect(await cms.forDraft(local).resolve("Banner")).toEqual(["summer", null]);
    expect(await titleOf(cms.forDraft("localhost:4547/@local"))).toBe("Sunny!");
    expect(await cms.forDraft("localhost:4547/@local").revision()).toBe("rev-1");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("DP-17: forced variants apply on top of the draft's changes; every variant shares one body", async () => {
    const api = deliveryApi();
    const banner = {
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "never" }, value: "draft fallback" },
        { rule: { __resolveType: "never" }, value: "draft summer" },
      ],
    };
    const pointer = api.draft({ set: { Banner: banner } });
    const parsed = parseDraftPointer(pointer)!;
    const cms = cmsOf();
    const forced = (index: number) =>
      formatDraftPointer({ ...parsed, variants: [{ block: "Banner", path: "", index }] });
    expect(await cms.forDraft(forced(1)).resolve("Banner")).toEqual(["draft summer", null]);
    expect(await cms.forDraft(forced(0)).resolve("Banner")).toEqual(["draft fallback", null]);
    expect(await cms.forDraft(pointer).resolve("Banner")).toEqual([undefined, null]); // the rules
    // One body for every variant: the first read downloads it, the others revalidate it (304).
    expect(api.draftFetches().map((r) => r.headers["if-none-match"])).toEqual([
      undefined,
      '"etag-1"',
      '"etag-1"',
    ]);
  });

  it("DP-18: empty changes (a draft before its first change) show production", async () => {
    const api = deliveryApi();
    const pointer = api.draft({}, { slug: "not-saved-yet" });
    const cms = cmsOf();
    expect(await titleOf(cms.forDraft(pointer))).toBe("Sunny!");
    const [pages] = await cms.forDraft(pointer).list("page");
    expect(pages).toHaveLength(2);
  });

  it("DP-19: release checks don't depend on drafts: a draft client schedules the same check, never in front of it", async () => {
    const api = deliveryApi();
    api.publish(
      await hashed("Published", {
        HelloWorld: { __resolveType: "post", name: "Republished", path: "/x", date: "2026-10-02" },
      }),
    );
    const channel = api.gate("/sites/acme/latest.json"); // the background check hangs
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = cmsOf({ site: SITE });
    const first = cms.forDraft(pointer);
    expect((await first.list<{ name: string }>("post"))[0]?.map((p) => p.name)).toEqual([
      "Hello, world",
    ]); // cold: the fallback is the base
    expect(api.assetFetches()).toBe(0);
    expect(api.latestFetches()).toBeLessThanOrEqual(1); // scheduled beside the draft, still pending
    channel.resolve();
    await flush();
    const next = cms.forDraft(pointer);
    expect(await titleOf(next)).toBe("Draft");
    expect((await next.list<{ name: string }>("post"))[0]?.map((p) => p.name)).toEqual([
      "Republished",
    ]);
  });

  it("DP-20: an entry named __proto__ in set stays an entry", async () => {
    const api = deliveryApi();
    const pointer = api.draft({
      set: JSON.parse(
        '{"__proto__": {"__resolveType": "seo", "title": "Odd", "description": "d"}}',
      ),
    });
    const [entry] = await cmsOf().forDraft(pointer).resolve("__proto__", { run: false });
    expect(entry).toEqual({ __resolveType: "seo", title: "Odd", description: "d" });
    expect(({} as Record<string, unknown>).title).toBeUndefined();
  });

  it("DP-21: a response that was redirected anyway (a fetch polyfill ignoring redirect: manual) is refused", async () => {
    const changes = { set: { SummerSEO: seoEntry("Elsewhere") }, delete: [] };
    const redirected = (url: string, flag: boolean) => {
      const response = Response.json(changes);
      Object.defineProperty(response, "redirected", { value: flag });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    for (const [url, flag] of [
      ["https://evil.example/changes", false],
      [`https://${DRAFT_HOST}/elsewhere`, true],
    ] as const) {
      resetForTests();
      const api = deliveryApi();
      const pointer = api.draft({});
      api.respond("summer-sale", () => redirected(url, flag));
      expect({ url, ...(await failed(cmsOf().forDraft(pointer))) }).toEqual({ url, ...FAILED });
    }
  });
});

// ---------------------------------------------------------------------------
// releases-and-deployment.mdx
// ---------------------------------------------------------------------------

describe("releases-and-deployment", () => {
  it("RD-2: without hosted, a server serves exactly the content module's revision", async () => {
    const content = docsSnapshot("rev-build");
    const cms = createCMS({ blocks: docsBlocks(), content });
    expect(await cms.forRelease().revision()).toBe("rev-build");
    await cms.update();
    expect(await cms.forRelease().revision()).toBe("rev-build");
  });

  it("RD-4: a hot reload handing createCMS a new content module serves the new content", async () => {
    const v1 = { ...docsSnapshot("rev-1"), root: ".deco" };
    const v2 = structuredClone({ ...docsSnapshot("rev-1"), root: ".deco" });
    (v2.blocks.SummerSEO as { title: string }).title = "Edited";
    createCMS({ blocks: docsBlocks(), content: v1 });
    const cms = createCMS({ blocks: docsBlocks(), content: v2 });
    expect(await titleOf(cms.forRelease())).toBe("Edited");
  });

  it("RD-5: a client's first call picks a revision; later and concurrent calls reuse it", async () => {
    let n = 0;
    const loader: Loader = { load: async () => docsSnapshot(`rev-${++n}`) };
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    const client = cms.forRelease();
    await client.list("seo");
    await client.resolve("SummerSEO");
    expect(await client.revision()).toBe("rev-1");
    const fresh = cms.forRelease();
    const [, , r] = await Promise.all([
      fresh.list("seo"),
      fresh.resolve("SummerSEO"),
      fresh.revision(),
    ]);
    expect(r).toBe("rev-2");
    expect(n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// hosted.mdx
// ---------------------------------------------------------------------------

describe("hosted", () => {
  it("H-1/H-7: createCMS takes site, token, telemetry and interval", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: undefined,
      token: undefined,
      telemetry: false,
      interval: 60_000,
    });
    expect(await cms.forRelease().revision()).toBe("rev-1");
  });

  it("H-3: without site the CMS reads content only, with no delivery request; a token without site is a configuration error", async () => {
    const api = deliveryApi();
    for (const site of [undefined, ""]) {
      resetForTests();
      const content = docsSnapshot();
      const cms = createCMS({ blocks: docsBlocks(), content, site, telemetry: false });
      expect(await cms.forRelease().revision()).toBe(content.revision);
      await cms.update();
      await flush();
    }
    for (const site of [undefined, ""]) {
      resetForTests();
      expect(() =>
        createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site, token: TOKEN }),
      ).toThrow("token needs site: pass both, or site alone");
    }
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("H-4/HRI-1: with site, content is the fallback while delivery is unreachable", async () => {
    const api = deliveryApi();
    api.fail(true);
    const content = docsSnapshot();
    const cms = createCMS({ blocks: docsBlocks(), content, site: SITE });
    const client = cms.forRelease();
    const [entries, error] = await client.list("seo");
    expect(error).toBeNull();
    expect(entries).toHaveLength(1);
    expect(await titleOf(client)).toBe("Sunny!");
    await expect(cms.update()).resolves.toEqual({ updated: false });
    expect(api.latestFetches()).toBeGreaterThan(0); // remoteLoader wrapped it
  });

  it("H-5: in development (dev: true), releases stay on local files but ?__draft= still loads", async () => {
    const api = deliveryApi();
    api.publish(await hashed("Published"));
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      dev: true,
    });
    cms.forRelease();
    await flush();
    await cms.update();
    expect(api.latestFetches()).toBe(0);
    expect(await titleOf(cms.forRelease())).toBe("Sunny!");
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
  });

  it("H-6: site alone never sends telemetry; site reads no environment variable", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otel.example.com");
    vi.stubEnv("DECO_SITE_TOKEN", TOKEN);
    const api = deliveryApi();
    api.publish(await hashed("Published"));
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: SITE });
    await cms.update();
    const client = cms.forRelease();
    await client.resolve("SummerPage");
    await client.list("page", { run: true });
    await flush(50);
    for (const { url } of api.requests) expect(url.startsWith(`${ORIGIN}/`)).toBe(true);
  });

  it("H-12: a token sends telemetry to the hosted collector as a Bearer token; analytics defaults to the hosted one", async () => {
    const destination = resolveDestination(undefined, SITE, TOKEN);
    expect(destination?.endpoint).toBe("https://otel.decocms.com");
    expect(destination?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(resolveDestination(undefined, SITE)).toBeNull();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const { analytics } = await cms.settings();
    expect(analytics.collector).toBe(HOSTED_ANALYTICS_COLLECTOR);
  });
});

// ---------------------------------------------------------------------------
// hosted-publishing.mdx
// ---------------------------------------------------------------------------

describe("hosted-publishing", () => {
  it("HP-1/HRI-2: requests read memory and never wait for a pending check", async () => {
    const hang = new Promise<Response>(() => {});
    const fetch = vi.fn(() => hang);
    vi.stubGlobal("fetch", fetch);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    void cms.update(); // a check that never finishes
    const client = cms.forRelease();
    const result = await Promise.race([client.list("seo"), flush(200).then(() => "timeout")]);
    expect(result).not.toBe("timeout");
    expect(fetch).toHaveBeenCalled();
  });

  it("HP-2: a release swaps in for the next client; clients already reading keep their revision", async () => {
    const api = deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    const before = cms.forRelease();
    expect(await titleOf(before)).toBe("Sunny!");
    api.publish(await hashed("New release"));
    await cms.update();
    expect(await titleOf(before)).toBe("Sunny!");
    expect(await titleOf(cms.forRelease())).toBe("New release");
  });

  it("HP-3: at request time an unfit block fails alone, and two routes for one URL pick the earlier", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const client = cms.forRelease();
    const sections = [
      { __resolveType: "hero", title: "ok" },
      { __resolveType: "not-deployed-yet", title: "new" },
      { __resolveType: "promo-banner", title: "ok", href: "/" },
    ];
    const results = await Promise.all(sections.map((s) => client.resolve(s)));
    expect(results.map(([, error]) => error?.code ?? null)).toEqual([null, "UNKNOWN_BLOCK", null]);
    const a = { name: "A", path: "/same" };
    const b = { name: "B", path: "/same" };
    expect(matchRoute("/same", { routes: [a, b] })).toMatchObject({ kind: "match", entry: a });
  });

  it("HP-4: cms.update() checks at once and never throws", async () => {
    const api = deliveryApi();
    api.fail(true);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    await expect(cms.update()).resolves.toEqual({ updated: false });
    api.fail(false);
    api.publish(await hashed("Now"));
    await expect(cms.update()).resolves.toEqual({ updated: true });
    expect(await titleOf(cms.forRelease())).toBe("Now");
  });

  describe("check schedule", () => {
    // Background work goes through the host hook so a tick awaits exactly the
    // checks it scheduled: a timer-based flush can return before a loaded
    // machine runs them, and the counts below would read one short.
    const HOOK = Symbol.for("decocms.blocks.background");
    const g = globalThis as { [HOOK]?: (task: () => Promise<void>) => void };
    let background: Promise<void>[] = [];
    let now = 1_000_000;
    beforeEach(() => {
      now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      background = [];
      g[HOOK] = (task) => void background.push(task());
    });
    afterEach(() => {
      delete g[HOOK];
    });

    /** Creates a CMS over an updatable loader and returns a probe of when checks run. */
    function scheduled(config: { interval?: number } = {}) {
      const update = vi.fn(async () => ({ updated: false }));
      const loader: Loader = { load: async () => docsSnapshot(), update };
      const cms = createCMS({ blocks: docsBlocks(), content: loader, ...config });
      return {
        update,
        async tick(ms: number) {
          now += ms;
          cms.forRelease();
          await Promise.all(background.splice(0));
          return update.mock.calls.length;
        },
      };
    }

    async function measured(config: { interval?: number } = {}) {
      vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
      const probe = scheduled(config);
      expect(await probe.tick(0)).toBe(1); // first use
      let elapsed = 0;
      for (const step of [59_999, 1]) {
        elapsed += step;
        const calls = await probe.tick(step);
        if (calls === 2) return elapsed;
      }
      // Larger intervals: step to them.
      for (;;) {
        elapsed += 10_000;
        if ((await probe.tick(10_000)) === 2) return elapsed;
        if (elapsed > 600_000) return Infinity;
      }
    }

    it("HP-5: interval: 120_000 checks every 2 minutes", async () => {
      expect(await measured({ interval: 120_000 })).toBe(120_000);
    });

    it("HP-6: interval defaults to 60 000 ms; DECO_CONTENT_INTERVAL isn't read", async () => {
      expect(await measured()).toBe(60_000);
      resetForTests();
      vi.stubEnv("DECO_CONTENT_INTERVAL", "90000");
      expect(await measured()).toBe(60_000);
      resetForTests();
      expect(await measured({ interval: 90_000 })).toBe(90_000);
    });

    it("HP-6: values below 60 000 ms are raised with a warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await measured({ interval: 1000 })).toBe(60_000);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("interval 1000 ms is below the minimum; raised to 60000 ms"),
      );
    });

    it("HP-7/HRI-15: any loader with update() is checked on first use and then every interval", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const probe = scheduled();
      expect(await probe.tick(0)).toBe(1);
      expect(await probe.tick(30_000)).toBe(1);
      expect(await probe.tick(30_000)).toBe(2);
      expect(await probe.tick(60_000)).toBe(3);
    });

    it("HP-8: each check runs one interval ± up to 10 s after the previous one", async () => {
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      const early = scheduled();
      expect(await early.tick(0)).toBe(1);
      expect(await early.tick(49_999)).toBe(1);
      expect(await early.tick(1)).toBe(2); // 60 s − 10 s
      resetForTests();
      random.mockReturnValue(0.999999);
      const late = scheduled();
      expect(await late.tick(0)).toBe(1);
      expect(await late.tick(69_000)).toBe(1);
      expect(await late.tick(1_000)).toBe(2); // ~60 s + 10 s
    });
  });

  it("HP-9: an unchanged latest.json costs one small request, no revision download", async () => {
    const api = deliveryApi();
    api.publish(await hashed("Once"));
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: SITE });
    await cms.update();
    const assets = api.assetFetches();
    await cms.update();
    await cms.update();
    expect(api.assetFetches()).toBe(assets);
    expect(api.latestFetches()).toBe(3);
  });

  it("HP-10: a network error or an unparseable snapshot leaves memory as it was", async () => {
    const api = deliveryApi();
    const good = await hashed("Good");
    api.publish(good);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    await cms.update();
    const broken = await hashed("Broken");
    api.point(broken.revision);
    api.asset(api.assetPath(broken.revision), new Response("{not json", { status: 200 }));
    await expect(cms.update()).resolves.toEqual({ updated: false });
    api.fail(true);
    await expect(cms.update()).resolves.toEqual({ updated: false });
    expect(await titleOf(cms.forRelease())).toBe("Good");
  });

  it("HP-11: a client never mixes entries from two revisions", async () => {
    const api = deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    const client = cms.forRelease();
    const [first] = await client.list("seo");
    api.publish(
      await hashed("New", { Other: { __resolveType: "seo", title: "o", description: "o" } }),
    );
    await cms.update();
    const [second] = await client.list("seo");
    expect(second).toEqual(first);
    expect(await client.revision()).toBe("rev-1");
  });

  it("HP-13: a type the deployed code lacks fails that block with UNKNOWN_BLOCK", async () => {
    const api = deliveryApi();
    api.publish(
      await hashed("x", { NewBanner: { __resolveType: "brand-new-banner", title: "t" } }),
    );
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    await cms.update();
    const client = cms.forRelease();
    const [, error] = await client.resolve("NewBanner");
    expect(error?.code).toBe("UNKNOWN_BLOCK");
    const [seo, seoError] = await client.resolve("SummerSEO");
    expect(seoError).toBeNull();
    expect(seo).toMatchObject({ title: "x" });
  });

  it("HP-16: remoteLoader(content, { site }) is a loader whose load() reports the served revision", async () => {
    deliveryApi();
    const content = docsSnapshot();
    const connected = remoteLoader(content, { site: SITE }) as Loader;
    expect((await connected.load()).revision).toBe(content.revision);
    // The site reads its own env and passes it; an unset value is a plain loader.
    const env = { DECO_SITE: undefined } as Record<string, string | undefined>;
    const loader = remoteLoader(content, { site: env.DECO_SITE as string });
    expect(typeof (loader as Loader).load).toBe("function");
    expect((loader as Loader).update).toBeUndefined();
  });

  it("HP-17: a server that hasn't fetched a release reports its fallback's revision", async () => {
    deliveryApi().fail(true);
    const content = await contentModule();
    const cms = createCMS({ blocks: docsBlocks(), content, site: SITE });
    expect(await cms.forRelease().revision()).toBe(content.revision);
  });
});

// ---------------------------------------------------------------------------
// hosted-drafts.mdx
// ---------------------------------------------------------------------------

describe("hosted-drafts", () => {
  it("HD-1: pointer is <host><path>@<version>, version after the last @; format round-trips", async () => {
    const raw = "api.deco.example/drafts/acme/feat-summer?token=abc@9f3c1a";
    const parsed = parseDraftPointer(raw);
    expect(parsed).toEqual({
      host: "api.deco.example",
      path: "/drafts/acme/feat-summer?token=abc",
      version: "9f3c1a",
    });
    expect(formatDraftPointer(parsed!)).toBe(raw);
    const link = new URL(`https://store.example.com/summer?__draft=${encodeURIComponent(raw)}`);
    expect(await draftPointer(new Request(link))).toBe(raw);
  });

  it("HD-2: forDraft revalidates the draft on every read; an unchanged one is a 304 served from memory", async () => {
    const api = deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: SITE });
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    expect(api.draftFetches()).toHaveLength(2);
    expect(api.draftFetches()[1]?.headers["if-none-match"]).toBe('"etag-1"');
  });

  it("HD-3: a draft holds only changed blocks and deletions; every other block is inherited", async () => {
    const api = deliveryApi();
    const pointer = api.draft({
      set: { SummerSEO: seoEntry("Draft") },
      delete: ["HelloWorld"],
    });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    const draft = cms.forDraft(pointer);
    expect(await titleOf(draft)).toBe("Draft");
    const [pages] = await draft.list("page");
    const [released] = await cms.forRelease().list("page");
    const names = (list: unknown) => (list as { name: string }[]).map((page) => page.name);
    expect(names(pages)).toEqual(names(released)); // inherited from production
    expect(names(pages).length).toBeGreaterThan(0);
    expect((await draft.resolve("HelloWorld"))[1]?.code).toBe("NOT_FOUND");
    expect(await draft.list("post")).toEqual([[], null]);
  });

  it("HD-4: a draft that can't be fetched is an error, never published content", async () => {
    deliveryApi(); // the token in POINTER isn't the one the fake Studio signed: 401
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    const client = cms.forDraft(POINTER);
    const [value, error] = await client.resolve("SummerSEO");
    expect(value).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
    const [list, listError] = await client.list("seo");
    expect(list).toBeNull();
    expect(listError?.code).toBe("LOADER_FAILED");
  });

  it("HD-5: draftPointer reads ?__draft= or the cookie; draftCookie only answers ?__draft=", async () => {
    const fromUrl = new Request(`https://s.example/?__draft=${encodeURIComponent(POINTER)}`);
    expect(await draftPointer(fromUrl)).toBe(POINTER);
    expect(await draftCookie(fromUrl)).toMatch(new RegExp(`^${DRAFT_COOKIE}=`));
    const fromCookie = new Request("https://s.example/", {
      headers: { cookie: `${DRAFT_COOKIE}=${encodeURIComponent(POINTER)}` },
    });
    expect(await draftPointer(fromCookie)).toBe(POINTER);
    expect(await draftCookie(fromCookie)).toBeNull();
    const plain = new Request("https://s.example/");
    expect(await draftPointer(plain)).toBeNull();
    expect(await draftCookie(plain)).toBeNull();
  });

  it("HD-6: ?__draft=off expires the cookie and reads no pointer", async () => {
    const off = new Request("https://s.example/?__draft=off", {
      headers: { cookie: `${DRAFT_COOKIE}=${encodeURIComponent(POINTER)}` },
    });
    expect(await draftPointer(off)).toBeNull();
    expect(await draftCookie(off)).toMatch(/Max-Age=0/);
  });

  it("HD-7: the plain request handler example runs as written", async () => {
    const api = deliveryApi();
    const POINTER = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    const render = async (client: ReturnType<typeof cms.forRelease>, _request: Request) =>
      new Response(await titleOf(client));
    async function handle(request: Request) {
      const pointer = await cms.draftPointer(request);
      const client = pointer ? cms.forDraft(pointer) : cms.forRelease();
      const response = await render(client, request);
      const cookie = await cms.draftCookie(request);
      if (cookie) response.headers.append("Set-Cookie", cookie);
      return response;
    }
    const first = await handle(
      new Request(`https://s.example/summer?__draft=${encodeURIComponent(POINTER)}`),
    );
    expect(await first.text()).toBe("Draft");
    const setCookie = first.headers.get("set-cookie") ?? "";
    const next = await handle(
      new Request("https://s.example/other", { headers: { cookie: setCookie.split(";")[0]! } }),
    );
    expect(await next.text()).toBe("Draft");
    expect(next.headers.get("set-cookie")).toBeNull();
    const visitor = await handle(new Request("https://s.example/summer"));
    expect(await visitor.text()).toBe("Sunny!");
  });

  it("HD-8: without site and token, forDraft layers the draft over the content module; only the draft's host is asked", async () => {
    const api = deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    expect(api.requests.map((r) => new URL(r.url).host)).toEqual([DRAFT_HOST]);
  });

  it("HD-10: __deco_draft is the cookie draftCookie writes and draftPointer reads", async () => {
    const set = await draftCookie(
      new Request(`https://s.example/?__draft=${encodeURIComponent(POINTER)}`),
    );
    expect(set?.startsWith(`${DRAFT_COOKIE}=`)).toBe(true);
  });

  it("HD-12: examples never spell __draft or __deco_draft", () => {
    const examples = path.resolve(HERE, "../../../../../examples");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (/__draft|__deco_draft/.test(text)) hits.push(full);
        }
      }
    };
    walk(examples);
    expect(hits).toEqual([]);
  });

  it("HD-13: forDraft takes only the pointer string (the React Native example)", async () => {
    const api = deliveryApi();
    const POINTER = api.draft({ set: { SummerSEO: seoEntry("Mobile draft") } });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    const url = `mystore://preview?__draft=${encodeURIComponent(POINTER)}`;
    const pointer = new URL(url).searchParams.get("__draft");
    const client = pointer ? cms.forDraft(pointer) : cms.forRelease();
    expect(await titleOf(client)).toBe("Mobile draft");
    expect(cms.forDraft.length).toBe(1);
  });

  it("HD-14: parseDraftPointer and formatDraftPointer are exported from the package root", () => {
    expect(typeof (root as Record<string, unknown>).parseDraftPointer).toBe("function");
    expect(typeof (root as Record<string, unknown>).formatDraftPointer).toBe("function");
  });

  it("HD-15: a pointer naming another host is refused: error result, no fetch to it", async () => {
    const api = deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    const [value, error] = await cms.forDraft("evil.example/x?token=t@1").resolve("SummerSEO");
    expect(value).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
    expect(api.requests.filter((r) => r.url.includes("evil.example"))).toEqual([]);
  });

  it("HD-16: a malformed pointer loads nothing and returns an error", async () => {
    const api = deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    for (const pointer of ["garbage", "https://x/y@1", "@1", `${DRAFT_HOST}/x@`]) {
      const [value, error] = await cms.forDraft(pointer).list("seo");
      expect(value).toBeNull();
      expect(error?.code).toBe("LOADER_FAILED");
    }
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("HD-18: preview hosts from the release's CMS block: a draft previews on staging only, every other host serves the release", async () => {
    const api = deliveryApi();
    // The draft tries to allow its own host: settings come from the release, so it can't.
    const POINTER = api.draft({
      set: {
        SummerSEO: seoEntry("Preview"),
        CMS: { __resolveType: "cms-settings", preview: { hosts: ["*"] } },
      },
    });
    const release = docsSnapshot();
    release.blocks.CMS = {
      __resolveType: "cms-settings",
      preview: { hosts: ["staging.store.example.com"] },
    };
    const cms = createCMS({ blocks: docsBlocks(), content: release, site: SITE });
    const pick = async (request: Request) => {
      const pointer = await cms.draftPointer(request);
      const cookie = await cms.draftCookie(request);
      return { client: pointer ? cms.forDraft(pointer) : cms.forRelease(), cookie };
    };
    const q = `?__draft=${encodeURIComponent(POINTER)}`;
    const staging = await pick(new Request(`https://staging.store.example.com/${q}`));
    expect(await titleOf(staging.client)).toBe("Preview");
    expect(staging.cookie).not.toBeNull();
    // A preview of that draft doesn't change the settings either.
    expect((await cms.settings()).preview.hosts).toEqual(["staging.store.example.com"]);
    const live = await pick(new Request(`https://store.example.com/${q}`));
    expect(await titleOf(live.client)).toBe("Sunny!");
    expect(live.cookie).toBeNull();
    // A cookie set on staging is ignored on the public host too, without an error.
    const withCookie = await pick(
      new Request("https://store.example.com/", {
        headers: { cookie: `${DRAFT_COOKIE}=${encodeURIComponent(POINTER)}` },
      }),
    );
    expect(await titleOf(withCookie.client)).toBe("Sunny!");
  });
});

// ---------------------------------------------------------------------------
// api-reference.mdx › cms.settings() with hosted releases
// ---------------------------------------------------------------------------

describe("CMS settings from hosted releases", () => {
  const bundled = (): Snapshot => {
    const snapshot = docsSnapshot();
    snapshot.blocks.CMS = {
      __resolveType: "cms-settings",
      preview: { hosts: ["staging.example.com"] },
      analytics: { collector: "https://bundled.example/events" },
    };
    return snapshot;
  };

  it("S-1: offline, at boot, settings come from the bundled content module, with no fetch", async () => {
    const api = deliveryApi();
    api.fail(true);
    const cms = createCMS({ blocks: docsBlocks(), content: bundled(), site: SITE });
    const settings = await cms.settings();
    expect(settings.preview.hosts).toEqual(["staging.example.com"]);
    expect(settings.analytics.collector).toBe("https://bundled.example/events");
    expect(api.fetch).not.toHaveBeenCalled();
    // Drafts are gated by them even while the Deco API can't be reached.
    const link = `?__draft=${encodeURIComponent("delivery.decocms.com/x@v")}`;
    expect(await cms.draftPointer(new Request(`https://www.example.com/${link}`))).toBeNull();
    expect(api.fetch).not.toHaveBeenCalled();
    // A request serves the bundled release; the failed background check changes nothing.
    expect(await titleOf(cms.forRelease())).toBe("Sunny!");
    await flush(50);
    expect((await cms.settings()).preview.hosts).toEqual(["staging.example.com"]);
  });

  it("S-2: a newer release's settings arrive with the background check, never before", async () => {
    const api = deliveryApi();
    const next = await hashed("Published", {
      CMS: { __resolveType: "cms-settings", preview: { hosts: ["www.example.com"] } },
    });
    api.publish(next);
    const cms = createCMS({ blocks: docsBlocks(), content: bundled(), site: SITE });
    expect((await cms.settings()).preview.hosts).toEqual(["staging.example.com"]);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(await cms.update()).toEqual({ updated: true });
    expect((await cms.settings()).preview.hosts).toEqual(["www.example.com"]);
  });
});

// ---------------------------------------------------------------------------
// hosted-releases-internals.mdx
// ---------------------------------------------------------------------------

describe("hosted-releases-internals", () => {
  it("HRI-3: update() runs on first use, then a latest.json check every interval", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const api = deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    expect(api.latestFetches()).toBe(0); // nothing at construction
    cms.forRelease();
    await flush();
    expect(api.latestFetches()).toBe(1);
    now += 60_000;
    cms.forRelease();
    await flush();
    expect(api.latestFetches()).toBe(2);
  });

  describe("HRI-4: idle scheduling", () => {
    const updatable = () => {
      const update = vi.fn(async () => ({ updated: false }));
      const cms = createCMS({
        blocks: docsBlocks(),
        content: { load: async () => docsSnapshot(), update },
      });
      return { cms, update };
    };

    it("prefers requestIdleCallback", async () => {
      const ric = vi.fn((cb: () => void) => cb());
      vi.stubGlobal("requestIdleCallback", ric);
      vi.stubGlobal("scheduler", { postTask: vi.fn(async (cb: () => void) => cb()) });
      const { cms, update } = updatable();
      cms.forRelease();
      await flush();
      expect(ric).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it("else scheduler.postTask({ priority: 'background' })", async () => {
      vi.stubGlobal("requestIdleCallback", undefined);
      const postTask = vi.fn(async (cb: () => void) => cb());
      vi.stubGlobal("scheduler", { postTask });
      const { cms, update } = updatable();
      cms.forRelease();
      await flush();
      expect(postTask).toHaveBeenCalledWith(expect.any(Function), { priority: "background" });
      expect(update).toHaveBeenCalledTimes(1);
    });

    it("on Node, an unref'd timer plus setImmediate", async () => {
      vi.stubGlobal("requestIdleCallback", undefined);
      vi.stubGlobal("scheduler", undefined);
      const unref = vi.fn();
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
        const timer = realSetTimeout(cb, ms);
        const original = timer.unref.bind(timer);
        timer.unref = () => {
          unref();
          return original();
        };
        return timer;
      }) as typeof setTimeout);
      const immediate = vi.spyOn(globalThis, "setImmediate");
      const { cms, update } = updatable();
      cms.forRelease();
      vi.mocked(globalThis.setTimeout).mockRestore();
      await flush();
      expect(unref).toHaveBeenCalled();
      expect(immediate).toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
    });
  });

  it("HRI-5: no push signal: the core SDK exposes no inbound release route", () => {
    const sdk = fs.readFileSync(path.join(HERE, "../remoteLoader.ts"), "utf8");
    expect(sdk).not.toMatch(/webhook|addEventListener\(|createServer/i);
  });

  it("HRI-6: no ordering among pointers: an older publishedAt is followed like any other (it's compared only with the bundle's committedAt)", async () => {
    const api = deliveryApi();
    const loader = remote(docsSnapshot());
    const five = await hashed("Five");
    const four = await hashed("Four");
    api.publish(five);
    await loader.update?.();
    api.publish(four);
    api.setLatest({
      revision: four.revision,
      schemaHash: SCHEMA,
      publishedAt: "1970-01-01T00:00:00Z",
    });
    expect(await loader.update?.()).toEqual({ updated: true });
    expect((await loader.load()).revision).toBe(four.revision);
    const sdk = fs.readFileSync(path.join(HERE, "../remoteLoader.ts"), "utf8");
    expect(sdk).not.toMatch(/generation|channels/);
  });

  it("HRI-8: a revision object that isn't the one latest.json names is rejected", async () => {
    const api = deliveryApi();
    const real = await hashed("Real");
    const wrong = { revision: "e".repeat(40), schemaHash: SCHEMA, blocks: real.blocks };
    api.publish(real, wrong);
    const fallback = docsSnapshot();
    const loader = remote(fallback);
    await expect(loader.update?.()).rejects.toThrow(/not the revision latest\.json names/);
    expect(await loader.load()).toBe(fallback);
  });

  it("HRI-9: a loader with its own revision scheme is downloaded once", async () => {
    const api = deliveryApi();
    const custom: Loader = { load: async () => docsSnapshot("my-own-scheme-1") };
    const loader = remote(custom);
    api.publish(await hashed("Hosted"));
    await loader.update?.();
    await loader.update?.();
    await loader.update?.();
    expect(api.assetFetches()).toBe(1);
  });

  it("HRI-10/HD-4: a draft that can't be fetched is LOADER_FAILED on every call; published content is never substituted", async () => {
    const api = deliveryApi();
    api.publish(await hashed("Release"));
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
    });
    await cms.update();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    api.respond("summer-sale", () => new Response("no such project", { status: 404 }));
    const [value, error] = await cms.forDraft(pointer).resolve("SummerSEO");
    expect(value).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
  });

  it("HRI-11: instances live on globalThis under Symbol.for('decocms.blocks…') keys", () => {
    const config = {
      blocks: docsBlocks(),
      content: { ...docsSnapshot(), root: ".deco" },
      site: SITE,
      token: TOKEN,
    };
    const a = createCMS(config);
    const b = createCMS({ ...config, content: { ...docsSnapshot(), root: ".deco" } });
    expect(instanceOf(b)).toBe(instanceOf(a));
    const keys = Object.getOwnPropertySymbols(globalThis)
      .map((s) => Symbol.keyFor(s))
      .filter((k): k is string => typeof k === "string" && k.startsWith("decocms.blocks"));
    expect(keys.some((k) => k.startsWith("decocms.blocks.cms:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("decocms.blocks.remote:"))).toBe(true);
    expect(keys.join("\n")).not.toContain(TOKEN);
  });

  it("HRI-12: the key is the site and the content identity, never the revision or the token", async () => {
    const blocks = docsBlocks();
    const a = createCMS({
      blocks,
      content: { ...docsSnapshot("rev-1"), root: ".deco" },
      site: SITE,
    });
    const reloaded = createCMS({
      blocks,
      content: { ...docsSnapshot("rev-2"), root: ".deco" },
      site: SITE,
    });
    expect(reloaded).toBe(a);
    expect(await reloaded.forRelease().revision()).toBe("rev-2");
    const other = createCMS({
      blocks,
      content: { ...docsSnapshot("rev-2"), root: ".deco" },
      site: "other",
    });
    expect(other).not.toBe(a);
    const otherFolder = createCMS({
      blocks,
      content: { ...docsSnapshot("rev-2"), root: "apps/b/.deco" },
      site: SITE,
    });
    expect(otherFolder).not.toBe(a);
  });

  it("HRI-13: a second call with other options keeps the first instance and names the option", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = { ...docsSnapshot(), root: ".deco" };
    const a = createCMS({ blocks: docsBlocks(), content, interval: 60_000 });
    const b = createCMS({ blocks: docsBlocks(), content, interval: 120_000 });
    expect(instanceOf(b)).toBe(instanceOf(a));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("interval"));
  });

  it("HRI-14: resetForTests() clears every stored instance", () => {
    const content = { ...docsSnapshot(), root: ".deco" };
    const a = createCMS({ blocks: docsBlocks(), content, site: SITE });
    const loaderA = remoteLoader(content, { site: SITE });
    resetForTests();
    expect(createCMS({ blocks: docsBlocks(), content, site: SITE })).not.toBe(a);
    expect(remoteLoader(content, { site: SITE })).not.toBe(loaderA);
    expect(typeof (root as Record<string, unknown>).resetForTests).toBe("function");
  });

  describe("HRI-16..HRI-21: whoever is newer wins (latest.json publishedAt vs the bundle's committedAt)", () => {
    const at = (hour: number) => `2026-10-07T${String(hour).padStart(2, "0")}:00:00.000Z`;
    /** The content module `deco content` wrote from a commit made at `committedAt`. */
    const built = (committedAt?: string): Snapshot =>
      committedAt === undefined ? docsSnapshot() : { ...docsSnapshot(), committedAt };
    /** Studio's Publish / Make current / Resync, at `publishedAt`. */
    async function release(
      api: ReturnType<typeof deliveryApi>,
      title: string,
      publishedAt: string,
      schemaHash = SCHEMA,
    ) {
      const snapshot = await hashed(title);
      api.publish(snapshot, undefined, schemaHash);
      api.setLatest({ revision: snapshot.revision, schemaHash, publishedAt });
      return snapshot;
    }

    it("HRI-16: publish, then deploy: the bundle wins", async () => {
      const api = deliveryApi();
      await release(api, "Published", at(10));
      const cms = createCMS({ blocks: docsBlocks(), content: built(at(11)), site: SITE });
      expect(await cms.update()).toEqual({ updated: false });
      expect(api.assetFetches()).toBe(0);
      expect(await titleOf(cms.forRelease())).toBe("Sunny!");
    });

    it("HRI-17: deploy, then publish: the CDN wins", async () => {
      const api = deliveryApi();
      await release(api, "Published", at(12));
      const cms = createCMS({ blocks: docsBlocks(), content: built(at(11)), site: SITE });
      expect(await cms.update()).toEqual({ updated: true });
      expect(await titleOf(cms.forRelease())).toBe("Published");
    });

    it("HRI-18: rollback after deploy: Make current writes publishedAt = now, so the CDN wins", async () => {
      const api = deliveryApi();
      const old = await release(api, "Old", at(9));
      const cms = createCMS({ blocks: docsBlocks(), content: built(at(11)), site: SITE });
      expect(await cms.update()).toEqual({ updated: false });
      api.setLatest({ revision: old.revision, schemaHash: SCHEMA, publishedAt: at(12) });
      expect(await cms.update()).toEqual({ updated: true });
      expect(await titleOf(cms.forRelease())).toBe("Old");
    });

    it("HRI-19: deploy after rollback: the bundle wins", async () => {
      const api = deliveryApi();
      const old = await release(api, "Old", at(9));
      api.setLatest({ revision: old.revision, schemaHash: SCHEMA, publishedAt: at(12) });
      const cms = createCMS({ blocks: docsBlocks(), content: built(at(13)), site: SITE });
      expect(await cms.update()).toEqual({ updated: false });
      expect(await titleOf(cms.forRelease())).toBe("Sunny!");
    });

    it("HRI-20: a newer release built for another schema: the bundle wins", async () => {
      const api = deliveryApi();
      await release(api, "Published", at(12), "6".repeat(64));
      const cms = createCMS({ blocks: docsBlocks(), content: built(at(11)), site: SITE });
      expect(await cms.update()).toEqual({ updated: false });
      expect(api.assetFetches()).toBe(0);
      expect(await titleOf(cms.forRelease())).toBe("Sunny!");
    });

    it("HRI-21: a bundle without committedAt (custom loader, older module, built outside git) is the oldest: the CDN wins", async () => {
      const api = deliveryApi();
      await release(api, "Published", "1970-01-01T00:00:00.000Z");
      const cms = createCMS({ blocks: docsBlocks(), content: built(), site: SITE });
      expect(await cms.update()).toEqual({ updated: true });
      expect(await titleOf(cms.forRelease())).toBe("Published");
      resetForTests();
      const custom: Loader = { load: async () => built() };
      const viaLoader = createCMS({ blocks: docsBlocks(), content: remote(custom) });
      expect(await viaLoader.update()).toEqual({ updated: true });
    });

    it("HRI-22: a build of an older commit that finishes after a publish loses to the CDN", async () => {
      const api = deliveryApi();
      // Commit at 10:00, publish at 11:00, the slow build of that commit finishes at 12:00:
      // the stamp is the commit time, so the build finishing last doesn't make it newer.
      await release(api, "Published", at(11));
      const cms = createCMS({ blocks: docsBlocks(), content: built(at(10)), site: SITE });
      expect(await cms.update()).toEqual({ updated: true });
      expect(await titleOf(cms.forRelease())).toBe("Published");
    });

    it("HRI-16..22: the SDK reads no git API and no environment", () => {
      const sdk = fs.readFileSync(path.join(HERE, "../remoteLoader.ts"), "utf8");
      expect(sdk).not.toMatch(/github|rev-parse|GIT_[A-Z]/i);
      expect([...sdk.matchAll(/^(?!\s*\*).*process\.env\.([A-Z_]+)/gm)].map((m) => m[1])).toEqual(
        [],
      );
      const cli = fs.readFileSync(path.join(HERE, "../cli/content.ts"), "utf8");
      // The CLI stamps the commit time of git HEAD; it reads no environment.
      expect(cli).toMatch(/execFileSync\("git", \["log", "-1", "--format=%cI"\]/);
      expect(cli).not.toMatch(/process\.env/);
    });
  });
});
