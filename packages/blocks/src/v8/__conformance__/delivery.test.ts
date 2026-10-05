// @vitest-environment node
/**
 * Docs conformance: content-delivery, draft-synchronization,
 * releases-and-deployment, hosted, hosted-publishing, hosted-drafts and
 * hosted-releases-internals (docs/content/next/*.mdx on the blocks-site
 * branch). Each test names the claim it checks (CD-*, RD-*, H-*, HP-*, HD-*,
 * HRI-*). A failing test is a claim the code doesn't meet yet.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as root from "../../index";
import { computeContentRevision } from "../../protocol/canonical";
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
import { docsBlocks, docsSnapshot, draftOverlayAssets } from "../testFixtures";
import type { Loader, RequestLike, Snapshot } from "../types";

/** cms.draftPointer and cms.draftCookie on a CMS with no settings: every host may preview. */
const helpers = () => createCMS({ blocks: {}, content: { revision: "draft-helpers", blocks: {} } });
const draftPointer = (request: RequestLike) => helpers().draftPointer(request);
const draftCookie = (request: RequestLike) => helpers().draftCookie(request);
const DRAFT_COOKIE = "deco-draft";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://delivery.decocms.com";
const HOST = new URL(ORIGIN).host;
const SITE = "acme";
const TOKEN = "site-token";
const MANIFEST_URL = `${ORIGIN}/sites/acme/channels/production.json`;
/** A pointer string, for the cookie and parsing claims; drafts that load come from api.draft(). */
const POINTER = `${HOST}/drafts/acme/feat-summer?token=abc@9f3c1a`;
/** The grant the site editor signs into a pointer's query; the fake API accepts only it. */
const GRANT = "token=abc";

const remote = (fallback: Snapshot | Loader) =>
  remoteLoader(fallback, { site: SITE, token: TOKEN }) as Loader;
const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

let savedInterval: string | undefined;
beforeEach(() => {
  resetForTests();
  savedInterval = process.env.DECO_CONTENT_INTERVAL;
  delete process.env.DECO_CONTENT_INTERVAL;
});
afterEach(async () => {
  await flush(); // let background checks a test started finish against its own fetch stub
  if (savedInterval === undefined) delete process.env.DECO_CONTENT_INTERVAL;
  else process.env.DECO_CONTENT_INTERVAL = savedInterval;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetForTests();
});

async function hashed(title: string, extra: Record<string, unknown> = {}): Promise<Snapshot> {
  const blocks = { SummerSEO: { __resolveType: "seo", title, description: "d" }, ...extra };
  return { revision: await computeContentRevision(blocks), blocks };
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
 * A fake delivery API: a channel manifest, immutable revision assets, and
 * draft overlay assets that need the site token and the grant.
 */
function deliveryApi() {
  const assets = new Map<string, unknown>();
  const gates = new Map<string, Deferred>();
  let manifest: Record<string, unknown> | undefined;
  let failAll = false;
  /** What an authorized overlay manifest response says about caching (the grant's remaining life). */
  let manifestCaching = "private, max-age=3600";
  let grantsExpired = false;
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url, headers });
    if (failAll) throw new TypeError("fetch failed");
    if (!url.startsWith(ORIGIN)) return new Response("wrong host", { status: 599 });
    const pathname = url.slice(ORIGIN.length);
    const p = pathname.split("?")[0] ?? "";
    await gates.get(p)?.promise;
    if (url === MANIFEST_URL) {
      if (!manifest) return new Response("missing", { status: 404 });
      return Response.json(manifest);
    }
    if (/^\/sites\/[^/]+\/(drafts|draft-blocks)\//.test(p)) {
      const query = pathname.includes("?") ? pathname.slice(pathname.indexOf("?") + 1) : "";
      if (headers.authorization !== `Bearer ${TOKEN}` || query !== GRANT || grantsExpired) {
        return new Response("forbidden", { status: 403, headers: { "cache-control": "no-store" } });
      }
    }
    if (assets.has(p)) {
      const body = assets.get(p);
      if (body instanceof Response) return body;
      const caching = p.includes("/drafts/")
        ? manifestCaching
        : p.includes("/draft-blocks/")
          ? "private, max-age=31536000, immutable"
          : undefined;
      return Response.json(body, caching ? { headers: { "cache-control": caching } } : undefined);
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    requests,
    assetPath: (revision: string) => `/sites/acme/revisions/${revision}.json`,
    publish(generation: number, snapshot: Snapshot, body: unknown = snapshot) {
      const p = `/sites/acme/revisions/${snapshot.revision}.json`;
      assets.set(p, body);
      manifest = { format: 1, generation, revision: snapshot.revision, snapshot: p };
    },
    point(generation: number, revision: string) {
      manifest = {
        format: 1,
        generation,
        revision,
        snapshot: `/sites/acme/revisions/${revision}.json`,
      };
    },
    setManifest(value: Record<string, unknown>) {
      manifest = value;
    },
    asset(p: string, body: unknown) {
      assets.set(p, body);
    },
    /** Prepares a draft overlay's assets and returns the pointer the site editor would sign. */
    async draft(changes: { set?: Record<string, unknown>; delete?: string[] }, grant = GRANT) {
      const prepared = await draftOverlayAssets(SITE, changes);
      for (const [p, body] of prepared.assets) assets.set(p, body);
      return `${HOST}/sites/${SITE}/drafts?${grant}@${prepared.version}`;
    },
    draftFetches: () =>
      requests.filter((r) => /\/sites\/acme\/(drafts|draft-blocks)\//.test(r.url)),
    gate(p: string) {
      const d = deferred();
      gates.set(p, d);
      return d;
    },
    fail(value: boolean) {
      failAll = value;
    },
    /** The Cache-Control an authorized overlay manifest is served with. */
    manifestCaching(value: string) {
      manifestCaching = value;
    },
    /** From now on every draft read is refused, as after the grant's expiry. */
    expireGrants() {
      grantsExpired = true;
    },
    assetFetches: () => requests.filter((r) => r.url.includes("/revisions/")).length,
    manifestFetches: () => requests.filter((r) => r.url === MANIFEST_URL).length,
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
  it("CD-1: the SDK never calls GitHub; every fetch goes to the delivery origin", async () => {
    const source = fs.readFileSync(path.join(HERE, "../remoteLoader.ts"), "utf8");
    expect(source).not.toMatch(/github/i);
    const api = deliveryApi();
    api.publish(1, await hashed("Published"));
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const loader = remote(docsSnapshot());
    await loader.update?.();
    await loader.load(pointer);
    expect(api.requests.length).toBeGreaterThan(0);
    for (const { url } of api.requests) expect(url.startsWith(`${ORIGIN}/`)).toBe(true);
  });

  it("CD-3: one canonical hash, insertion-order independent, shared by the CLI and remoteLoader", async () => {
    const a = { A: { __resolveType: "seo", x: 1, y: 2 }, B: { z: [1, 2] } };
    const b = { B: { z: [1, 2] }, A: { y: 2, __resolveType: "seo", x: 1 } };
    expect(await computeContentRevision(a)).toBe(await computeContentRevision(b));
    const cli = fs.readFileSync(path.join(HERE, "../cli/content.ts"), "utf8");
    const sdk = fs.readFileSync(path.join(HERE, "../remoteLoader.ts"), "utf8");
    const shared =
      // remoteLoader imports the SDK's leaf module; the CLI may go through the protocol's re-export.
      /import \{[^}]*\bcomputeContentRevision\b[^}]*\} from "[./]+(protocol\/)?canonical\.ts"/;
    expect(cli).toMatch(shared);
    expect(sdk).toMatch(shared);
  });

  it("CD-4/CD-5/CD-6: reads /sites/<site>/channels/production.json and the { revision, blocks } asset it names", async () => {
    const api = deliveryApi();
    const release = await hashed("Generation 184");
    // The docs' manifest example, with a real content hash as the revision.
    api.setManifest({
      format: 1,
      generation: 184,
      revision: release.revision,
      snapshot: `/sites/acme/revisions/${release.revision}.json`,
    });
    api.asset(`/sites/acme/revisions/${release.revision}.json`, release);
    const loader = remote(docsSnapshot());
    expect(await loader.update?.()).toEqual({ updated: true });
    expect(api.requests.map((r) => r.url)).toEqual([
      MANIFEST_URL,
      `${ORIGIN}/sites/acme/revisions/${release.revision}.json`,
    ]);
    const loaded = await loader.load();
    expect(Object.keys(loaded).sort()).toEqual(["blocks", "revision"]);
    expect(loaded.revision).toBe(release.revision);
  });

  it("CD-7: refuses unknown formats and snapshot paths outside the origin or site namespace", async () => {
    const release = await hashed("Evil");
    const bad = [
      { format: 2, snapshot: `/sites/acme/revisions/${release.revision}.json` },
      { format: 1, snapshot: `/sites/other/revisions/${release.revision}.json` },
      { format: 1, snapshot: `https://evil.example/sites/acme/revisions/${release.revision}.json` },
      { format: 1, snapshot: `/sites/acme/revisions/../../other/revisions/x.json` },
    ];
    for (const fields of bad) {
      resetForTests();
      const api = deliveryApi();
      api.asset(`/sites/acme/revisions/${release.revision}.json`, release);
      api.setManifest({ generation: 1, revision: release.revision, ...fields });
      const fallback = docsSnapshot();
      const loader = remote(fallback);
      await expect(loader.update?.()).rejects.toThrow();
      expect(api.assetFetches()).toBe(0);
      expect(await loader.load()).toBe(fallback);
    }
  });

  it("CD-11: a missing or failing asset keeps the last good content", async () => {
    const api = deliveryApi();
    const good = await hashed("Good");
    api.publish(1, good);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    await cms.update();
    expect(await titleOf(cms.forRelease())).toBe("Good");
    const missing = await hashed("Missing");
    api.point(2, missing.revision); // 404
    await expect(cms.update()).resolves.toEqual({ updated: false });
    api.asset(api.assetPath(missing.revision), new Response("boom", { status: 500 }));
    await expect(cms.update()).resolves.toEqual({ updated: false });
    expect(await titleOf(cms.forRelease())).toBe("Good");
  });

  it("CD-12: a rollback (higher generation, older revision) is adopted", async () => {
    const api = deliveryApi();
    const a = await hashed("A");
    const b = await hashed("B");
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    api.publish(183, a);
    await cms.update();
    api.publish(184, b);
    await cms.update();
    expect(await titleOf(cms.forRelease())).toBe("B");
    api.publish(185, a);
    expect(await cms.update()).toEqual({ updated: true });
    expect(await titleOf(cms.forRelease())).toBe("A");
  });

  it("CD-14: a draft is the exact overlay its version names: manifest, then changed blocks, from the site's delivery paths", async () => {
    const api = deliveryApi();
    const older = await api.draft({ set: { SummerSEO: seoEntry("Draft v1") } });
    await api.draft({ set: { SummerSEO: seoEntry("Newer save") } });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    expect(await titleOf(cms.forDraft(older))).toBe("Draft v1"); // never the newer save
    const version = parseDraftPointer(older)!.version;
    const hash = (await draftOverlayAssets(SITE, { set: { SummerSEO: seoEntry("Draft v1") } }))
      .overlay.set.SummerSEO;
    // (The release check forDraft schedules runs beside it, in the background.)
    expect(api.draftFetches().map((r) => r.url)).toEqual([
      `${ORIGIN}/sites/acme/drafts/${version}.json?${GRANT}`,
      `${ORIGIN}/sites/acme/draft-blocks/${hash}.json?${GRANT}`,
    ]);
    for (const r of api.requests) expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
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
    const revision = "f".repeat(64);
    api.point(1, revision);
    api.asset(api.assetPath(revision), new Response(body));
    const fallback = docsSnapshot();
    const loader = remote(fallback);
    await expect(loader.update?.()).rejects.toThrow();
    expect(await loader.load()).toBe(fallback);
    // Rejected by a size bound, not after buffering and failing to parse all of it.
    expect(pulled).toBeLessThan(TOTAL_MB);
  }, 60_000);

  it("CD-16: drafts kept in memory are bounded (old versions are evicted; their blocks stay cached)", async () => {
    const api = deliveryApi();
    const pointers: string[] = [];
    for (let i = 0; i < 40; i++) {
      pointers.push(
        await api.draft({ set: { SummerSEO: seoEntry("Draft") }, delete: [`Gone${i}`] }),
      );
    }
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    for (const pointer of pointers) await titleOf(cms.forDraft(pointer));
    expect(api.requests.filter((r) => r.url.includes("/draft-blocks/"))).toHaveLength(1);
    const before = api.requests.length;
    await titleOf(cms.forDraft(pointers[0]!));
    // The first manifest was evicted and fetched again; its changed block is still cached.
    expect(api.requests.slice(before).map((r) => r.url)).toEqual([
      `${ORIGIN}/sites/acme/drafts/${parseDraftPointer(pointers[0])!.version}.json?${GRANT}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// content-delivery.mdx#exact-draft-previews, hosted-drafts.mdx,
// hosted-releases-internals.mdx, studio-implementation.mdx: draft overlays
// ---------------------------------------------------------------------------

describe("draft overlays", () => {
  const hostedCMS = (content: Snapshot | Loader = docsSnapshot()) =>
    createCMS({ blocks: docsBlocks(), content, site: SITE, token: TOKEN });

  it("DO-1: the manifest is { format: 1, set: { name: blockHash }, delete: [...] }, under the hash of its canonical JSON", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({
      set: { SummerSEO: seoEntry("Draft") },
      delete: ["HelloWorld"],
    });
    await hostedCMS().forDraft(pointer).revision();
    const version = parseDraftPointer(pointer)!.version;
    const response = await api.fetch(`${ORIGIN}/sites/acme/drafts/${version}.json?${GRANT}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const manifest = await response.json();
    expect(Object.keys(manifest).sort()).toEqual(["delete", "format", "set"]);
    expect(manifest.format).toBe(1);
    expect(manifest.delete).toEqual(["HelloWorld"]);
    expect(manifest).not.toHaveProperty("baseRevision");
    expect(await computeContentRevision(manifest)).toBe(version); // SHA-256 of canonical JSON
  });

  it("DO-2: a draft never fetches a production revision to align; the release check it schedules never runs in front of it", async () => {
    const api = deliveryApi();
    api.publish(1, await hashed("Published"));
    const channel = api.gate("/sites/acme/channels/production.json"); // the background check hangs
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = hostedCMS();
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft"); // a cold server: the fallback is the base
    expect(api.assetFetches()).toBe(0);
    expect(api.manifestFetches()).toBeLessThanOrEqual(1); // scheduled beside the draft, still pending
    channel.resolve();
  });

  it("DO-3: a new save downloads its small manifest and only the changed blocks missing from the cache", async () => {
    const api = deliveryApi();
    const cms = hostedCMS();
    const first = await api.draft({
      set: {
        SummerSEO: seoEntry("Draft"),
        HomePage: { __resolveType: "page", name: "Home", path: "/", sections: [] },
      },
    });
    await titleOf(cms.forDraft(first));
    expect(api.requests.filter((r) => r.url.includes("/draft-blocks/"))).toHaveLength(2);
    const before = api.draftFetches().length;
    const second = await api.draft({
      set: {
        SummerSEO: seoEntry("Draft, edited"),
        HomePage: { __resolveType: "page", name: "Home", path: "/", sections: [] },
      },
    });
    expect(await titleOf(cms.forDraft(second))).toBe("Draft, edited");
    const urls = api
      .draftFetches()
      .slice(before)
      .map((r) => r.url);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/drafts/");
    expect(urls[1]).toContain("/draft-blocks/"); // only SummerSEO's new hash
  });

  it("DO-4: lookups read replacements first, tombstones are absent, everything else is inherited", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({
      set: {
        SummerSEO: seoEntry("Draft"),
        NewPost: { __resolveType: "post", name: "New", path: "/blog/new", date: "2026-10-01" },
      },
      delete: ["HelloWorld", "LegacySummer"],
    });
    const draft = hostedCMS().forDraft(pointer);
    expect(await titleOf(draft)).toBe("Draft");
    expect((await draft.resolve("HelloWorld"))[1]?.code).toBe("NOT_FOUND");
    expect((await draft.resolve("LegacySummer"))[1]?.code).toBe("NOT_FOUND");
    const [product] = await draft.resolve("CurrentProduct");
    expect(product).toEqual({ name: "Summer shirt", slug: "summer-shirt" });
    // Enumeration is the union of names minus deletions.
    const [posts] = await draft.list<{ name: string }>("post");
    expect(posts?.map((post) => post.name)).toEqual(["New"]);
    expect(await draft.list("redirect")).toEqual([[], null]);
  });

  it("DO-5: an edited draft block wins in full; production changes inside it are not merged", async () => {
    const api = deliveryApi();
    const production = await hashed("Published", {
      SummerSEO: {
        __resolveType: "seo",
        title: "Published",
        description: "new production description",
      },
    });
    api.publish(1, production);
    const cms = hostedCMS();
    await cms.update();
    const pointer = await api.draft({
      set: { SummerSEO: { __resolveType: "seo", title: "Draft" } },
    });
    const [entry] = await cms.forDraft(pointer).resolve("SummerSEO", { run: false });
    expect(entry).toEqual({ __resolveType: "seo", title: "Draft" });
  });

  it("DO-6: the overlay is layered over shared production objects, and production is never mutated", async () => {
    const api = deliveryApi();
    const fallback = docsSnapshot();
    const before = JSON.stringify(fallback);
    const loader = remote(fallback);
    const pointer = await api.draft({
      set: { SummerSEO: seoEntry("Draft") },
      delete: ["HelloWorld"],
    });
    const view = await loader.load(pointer);
    expect(view.blocks.SummerCard).toBe(fallback.blocks.SummerCard);
    expect(view.blocks).not.toHaveProperty("HelloWorld");
    expect(JSON.stringify(fallback)).toBe(before);
    expect(await loader.load()).toBe(fallback);
  });

  it("DO-7: a client captures production once; the next client inherits a newer release without downloading the draft again", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = hostedCMS();
    const first = cms.forDraft(pointer);
    expect(await titleOf(first)).toBe("Draft");
    const firstRevision = await first.revision();
    const fetches = api.draftFetches().length;

    api.publish(
      1,
      await hashed("Published", {
        HelloWorld: { __resolveType: "post", name: "Republished", path: "/x", date: "2026-10-02" },
      }),
    );
    await cms.update();
    const [oldPosts] = await first.list<{ name: string }>("post");
    expect(oldPosts?.map((p) => p.name)).toEqual(["Hello, world"]); // in flight: its captured base

    const next = cms.forDraft(pointer);
    expect(await titleOf(next)).toBe("Draft");
    const [newPosts] = await next.list<{ name: string }>("post");
    expect(newPosts?.map((p) => p.name)).toEqual(["Republished"]);
    expect(api.draftFetches().length).toBe(fetches); // manifest and block from cache
    expect(await next.revision()).not.toBe(firstRevision);
  });

  it("DO-8: the draft revision is an opaque identity of (captured production, overlay version), not a release hash", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const fallback = docsSnapshot();
    const view = await remote(fallback).load(pointer);
    const version = parseDraftPointer(pointer)!.version;
    expect(view.revision).not.toBe(fallback.revision);
    expect(view.revision).toContain(fallback.revision);
    expect(view.revision).toContain(version);
    expect(view.revision).not.toBe(await computeContentRevision(view.blocks));
  });

  it("DO-9: every draft read carries the site token and the pointer's grant; a version alone unlocks nothing", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = hostedCMS();
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    for (const r of api.draftFetches()) {
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.url.endsWith(`?${GRANT}`)).toBe(true);
    }
    // The same overlay version with a forged grant: the manifest is asked for again, and refused.
    const forged = pointer.replace(GRANT, "token=forged");
    const [value, error] = await cms.forDraft(forged).resolve("SummerSEO");
    expect(value).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
    expect(api.requests.at(-1)?.url).toContain("token=forged");
  });

  it("DO-10: missing, unauthorized or invalid overlay assets fail the draft client, never showing published content", async () => {
    const cases: [string, (api: ReturnType<typeof deliveryApi>) => Promise<string>][] = [
      ["no manifest", async () => `${HOST}/sites/acme/drafts?${GRANT}@${"c".repeat(64)}`],
      [
        "unauthorized",
        async (api) => api.draft({ set: { SummerSEO: seoEntry("D") } }, "token=nope"),
      ],
      [
        "a missing changed block",
        async (api) => {
          const p = await api.draft({ set: { SummerSEO: seoEntry("D") } });
          const { overlay } = await draftOverlayAssets(SITE, { set: { SummerSEO: seoEntry("D") } });
          api.asset(
            `/sites/acme/draft-blocks/${overlay.set.SummerSEO}.json`,
            new Response("gone", { status: 404 }),
          );
          return p;
        },
      ],
      [
        "a changed block that doesn't match its hash",
        async (api) => {
          const p = await api.draft({ set: { SummerSEO: seoEntry("D") } });
          const { overlay } = await draftOverlayAssets(SITE, { set: { SummerSEO: seoEntry("D") } });
          api.asset(`/sites/acme/draft-blocks/${overlay.set.SummerSEO}.json`, seoEntry("Tampered"));
          return p;
        },
      ],
      [
        "a manifest that doesn't match its version",
        async (api) => {
          const p = await api.draft({ set: { SummerSEO: seoEntry("D") } });
          const version = parseDraftPointer(p)!.version;
          api.asset(`/sites/acme/drafts/${version}.json`, {
            format: 1,
            set: {},
            delete: ["SummerSEO"],
          });
          return p;
        },
      ],
      [
        "an unknown format",
        async (api) => publishManifest(api, { format: 2, set: {}, delete: [] }),
      ],
      [
        "an unexpected field",
        async (api) => publishManifest(api, { format: 1, set: {}, delete: [], baseRevision: "x" }),
      ],
      [
        "set and delete overlapping",
        async (api) =>
          publishManifest(api, { format: 1, set: { A: "d".repeat(64) }, delete: ["A"] }),
      ],
      [
        "a malformed block hash",
        async (api) => publishManifest(api, { format: 1, set: { A: "../x" }, delete: [] }),
      ],
    ];
    for (const [label, prepare] of cases) {
      resetForTests();
      const api = deliveryApi();
      api.publish(1, await hashed("Published"));
      const cms = hostedCMS();
      await cms.update();
      const client = cms.forDraft(await prepare(api));
      const [value, error] = await client.resolve("SummerSEO");
      expect({ label, value, code: error?.code }).toEqual({
        label,
        value: null,
        code: "LOADER_FAILED",
      });
      expect((await client.list("seo"))[1]?.code).toBe("LOADER_FAILED");
    }
  });

  it("DO-11: a failed overlay isn't cached: once its assets are ready, the next client loads it", async () => {
    const api = deliveryApi();
    const { version, assets } = await draftOverlayAssets(SITE, {
      set: { SummerSEO: seoEntry("Ready") },
    });
    const pointer = `${HOST}/sites/acme/drafts?${GRANT}@${version}`;
    const cms = hostedCMS();
    expect((await cms.forDraft(pointer).resolve("SummerSEO"))[1]?.code).toBe("LOADER_FAILED"); // preparing
    for (const [p, body] of assets) api.asset(p, body);
    expect(await titleOf(cms.forDraft(pointer))).toBe("Ready");
  });

  it("DO-12: a pointer into another site's drafts, or with a version that isn't an overlay hash, is refused without a fetch", async () => {
    const api = deliveryApi();
    const cms = hostedCMS();
    for (const pointer of [
      `${HOST}/sites/other/drafts?${GRANT}@${"a".repeat(64)}`,
      `${HOST}/sites/acme/drafts/x?${GRANT}@${"a".repeat(64)}`,
      `${HOST}/sites/acme/drafts?${GRANT}@9f3c1a`,
    ]) {
      expect((await cms.forDraft(pointer).resolve("SummerSEO"))[1]?.code).toBe("LOADER_FAILED");
    }
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("DO-13: a draft's assets over 64 MB are refused while they download", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Huge") } });
    const { overlay } = await draftOverlayAssets(SITE, { set: { SummerSEO: seoEntry("Huge") } });
    const CHUNK = new Uint8Array(1024 * 1024).fill(0x20);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 0) controller.enqueue(new TextEncoder().encode("["));
        if (pulled >= 192) return controller.close();
        pulled++;
        controller.enqueue(CHUNK);
      },
    });
    api.asset(`/sites/acme/draft-blocks/${overlay.set.SummerSEO}.json`, new Response(body));
    expect((await hostedCMS().forDraft(pointer).resolve("SummerSEO"))[1]?.code).toBe(
      "LOADER_FAILED",
    );
    expect(pulled).toBeLessThan(192);
  }, 60_000);

  it("DO-14: forced variants (__variant in the pointer) apply on top of the overlay; every variant shares one load", async () => {
    const api = deliveryApi();
    const banner = {
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "never" }, value: "draft fallback" },
        { rule: { __resolveType: "never" }, value: "draft summer" },
      ],
    };
    const pointer = await api.draft({ set: { Banner: banner } });
    const parsed = parseDraftPointer(pointer)!;
    const cms = hostedCMS();
    const forced = (index: number) =>
      formatDraftPointer({ ...parsed, variants: [{ block: "Banner", path: "", index }] });
    expect(await cms.forDraft(forced(1)).resolve("Banner")).toEqual(["draft summer", null]);
    expect(await cms.forDraft(forced(0)).resolve("Banner")).toEqual(["draft fallback", null]);
    expect(await cms.forDraft(pointer).resolve("Banner")).toEqual([undefined, null]); // the rules
    expect(api.draftFetches()).toHaveLength(2);
  });
});

describe("draft overlays: expiry and refresh", () => {
  const hostedCMS = () =>
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: SITE, token: TOKEN });
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  it("DO-15: an authorized manifest is cached only for its response's max-age, so an expired grant fails on a warm server", async () => {
    const api = deliveryApi();
    api.manifestCaching("private, max-age=120");
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const loader = remote(docsSnapshot());
    await loader.load(pointer);
    now += 119_000;
    await loader.load(pointer);
    expect(api.draftFetches()).toHaveLength(2); // manifest and block, once
    now += 2_000;
    api.expireGrants();
    await expect(loader.load(pointer)).rejects.toThrow(/HTTP 403/);
  });

  it("DO-16: a manifest served without max-age, or with no-store, is asked for on every load", async () => {
    for (const caching of ["private", "no-store, max-age=60"]) {
      resetForTests();
      const api = deliveryApi();
      api.manifestCaching(caching);
      const pointer = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
      const loader = remote(docsSnapshot());
      await loader.load(pointer);
      await loader.load(pointer);
      const version = parseDraftPointer(pointer)!.version;
      expect(api.draftFetches().filter((r) => r.url.includes(`/drafts/${version}`))).toHaveLength(
        2,
      );
      expect(api.draftFetches()).toHaveLength(3); // the block came from the cache
    }
  });

  it("DO-17: a CMS reuses a loaded draft for at most a minute, then loads it again (and its grant is checked)", async () => {
    const api = deliveryApi();
    api.manifestCaching("private, max-age=30");
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = hostedCMS();
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    now += 59_000;
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft"); // reused, though the manifest's max-age passed
    expect(api.draftFetches()).toHaveLength(2);
    now += 2_000;
    api.expireGrants();
    expect((await cms.forDraft(pointer).resolve("SummerSEO"))[1]?.code).toBe("LOADER_FAILED");
  });

  it("DO-18: release checks don't depend on drafts: a draft client schedules the same check, and later drafts inherit the new release", async () => {
    const api = deliveryApi();
    api.publish(
      1,
      await hashed("Published", {
        HelloWorld: { __resolveType: "post", name: "Republished", path: "/x", date: "2026-10-02" },
      }),
    );
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = hostedCMS();
    const first = cms.forDraft(pointer);
    expect((await first.list<{ name: string }>("post"))[0]?.map((p) => p.name)).toEqual([
      "Hello, world",
    ]); // cold: the fallback
    await flush(); // the release check, scheduled by the draft client as by any client
    expect(api.manifestFetches()).toBe(1);
    const next = cms.forDraft(pointer);
    expect(await titleOf(next)).toBe("Draft");
    expect((await next.list<{ name: string }>("post"))[0]?.map((p) => p.name)).toEqual([
      "Republished",
    ]);
  });
});

/** Stores a hand-written manifest under its real version, so only its shape is wrong. */
async function publishManifest(
  api: ReturnType<typeof deliveryApi>,
  manifest: Record<string, unknown>,
): Promise<string> {
  const version = await computeContentRevision(manifest);
  api.asset(`/sites/acme/drafts/${version}.json`, manifest);
  return `${HOST}/sites/acme/drafts?${GRANT}@${version}`;
}

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

  it("RD-6: client.revision() and cms.forRevision(revision) read the same content", async () => {
    let current = docsSnapshot("rev-1");
    const loader: Loader = { load: async () => current, update: async () => ({ updated: true }) };
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    const r = await cms.forRelease().revision();
    current = structuredClone(docsSnapshot("rev-2"));
    (current.blocks.SummerSEO as { title: string }).title = "Rev 2";
    await cms.update();
    expect(await titleOf(cms.forRelease())).toBe("Rev 2");
    const pinned = cms.forRevision(r);
    expect(await pinned.revision()).toBe("rev-1");
    expect(await titleOf(pinned)).toBe("Sunny!");
  });

  it("RD-7: a revision unlocks nothing: forRevision(<draft revision>) never reaches the draft", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Secret draft") } });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    const draft = cms.forDraft(pointer);
    expect(await titleOf(draft)).toBe("Secret draft");
    const byRevision = cms.forRevision(await draft.revision());
    expect(await titleOf(byRevision)).toBe("Sunny!");
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

  it("H-3: with site or token undefined the CMS reads content only, with no network", async () => {
    const api = deliveryApi();
    for (const [site, token] of [
      [SITE, undefined],
      [undefined, TOKEN],
    ] as const) {
      resetForTests();
      const content = docsSnapshot();
      const cms = createCMS({ blocks: docsBlocks(), content, site, token, telemetry: false });
      expect(await cms.forRelease().revision()).toBe(content.revision);
      await cms.update();
      await flush();
    }
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("H-4/HRI-1: with site and token, content is the fallback while the API is unreachable", async () => {
    const api = deliveryApi();
    api.fail(true);
    const content = docsSnapshot();
    const cms = createCMS({ blocks: docsBlocks(), content, site: SITE, token: TOKEN });
    const client = cms.forRelease();
    const [entries, error] = await client.list("seo");
    expect(error).toBeNull();
    expect(entries).toHaveLength(1);
    expect(await titleOf(client)).toBe("Sunny!");
    await expect(cms.update()).resolves.toEqual({ updated: false });
    expect(api.manifestFetches()).toBeGreaterThan(0); // remoteLoader wrapped it
  });

  it("H-5: in development, releases stay on local files but ?__draft= still loads", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const api = deliveryApi();
    api.publish(1, await hashed("Published"));
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    cms.forRelease();
    await flush();
    await cms.update();
    expect(api.manifestFetches()).toBe(0);
    expect(await titleOf(cms.forRelease())).toBe("Sunny!");
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
  });

  it("H-6: site and token alone never send telemetry", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
    const api = deliveryApi();
    api.publish(1, await hashed("Published"));
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    await cms.update();
    const client = cms.forRelease();
    await client.resolve("SummerPage");
    await client.list("page", { run: true });
    await flush(50);
    for (const { url } of api.requests) expect(url.startsWith(`${ORIGIN}/`)).toBe(true);
  });

  it("H-12: telemetry { site, token } goes to the hosted collector; analytics defaults to the hosted one", async () => {
    const destination = resolveDestination({ site: SITE, token: TOKEN });
    expect(destination?.endpoint).toMatch(/^https:\/\/[^/]*decocms\.com/);
    expect(destination?.headers.authorization).toBe(`Bearer ${TOKEN}`);
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
      token: TOKEN,
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
      token: TOKEN,
    });
    const before = cms.forRelease();
    expect(await titleOf(before)).toBe("Sunny!");
    api.publish(1, await hashed("New release"));
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
      token: TOKEN,
    });
    await expect(cms.update()).resolves.toEqual({ updated: false });
    api.fail(false);
    api.publish(1, await hashed("Now"));
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

    it("HP-6: interval defaults to DECO_CONTENT_INTERVAL, else 60 000 ms", async () => {
      expect(await measured()).toBe(60_000);
      resetForTests();
      process.env.DECO_CONTENT_INTERVAL = "90000";
      expect(await measured()).toBe(90_000);
    });

    it("HP-6: values below 60 000 ms, from interval or DECO_CONTENT_INTERVAL, are raised with a warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await measured({ interval: 1000 })).toBe(60_000);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("interval 1000 ms is below the minimum; raised to 60000 ms"),
      );
      resetForTests();
      warn.mockClear();
      process.env.DECO_CONTENT_INTERVAL = "1000";
      expect(await measured()).toBe(60_000);
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

  it("HP-9: an unchanged manifest costs one small request, no snapshot download", async () => {
    const api = deliveryApi();
    api.publish(1, await hashed("Once"));
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    await cms.update();
    const assets = api.assetFetches();
    await cms.update();
    await cms.update();
    expect(api.assetFetches()).toBe(assets);
    expect(api.manifestFetches()).toBe(3);
  });

  it("HP-10: a network error or an unparseable snapshot leaves memory as it was", async () => {
    const api = deliveryApi();
    const good = await hashed("Good");
    api.publish(1, good);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    await cms.update();
    const broken = await hashed("Broken");
    api.point(2, broken.revision);
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
      token: TOKEN,
    });
    const client = cms.forRelease();
    const [first] = await client.list("seo");
    api.publish(
      1,
      await hashed("New", { Other: { __resolveType: "seo", title: "o", description: "o" } }),
    );
    await cms.update();
    const [second] = await client.list("seo");
    expect(second).toEqual(first);
    expect(await client.revision()).toBe("rev-1");
  });

  it("HP-12/HRI-7: a manifest naming the content module's revision is served from the bundle", async () => {
    const api = deliveryApi();
    const content = await contentModule();
    api.point(7, content.revision);
    const cms = createCMS({ blocks: docsBlocks(), content, site: SITE, token: TOKEN });
    await cms.update();
    expect(api.assetFetches()).toBe(0);
    expect(await cms.forRelease().revision()).toBe(content.revision);
  });

  it("HP-13: a type the deployed code lacks fails that block with UNKNOWN_BLOCK", async () => {
    const api = deliveryApi();
    api.publish(
      1,
      await hashed("x", { NewBanner: { __resolveType: "brand-new-banner", title: "t" } }),
    );
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    await cms.update();
    const client = cms.forRelease();
    const [, error] = await client.resolve("NewBanner");
    expect(error?.code).toBe("UNKNOWN_BLOCK");
    const [seo, seoError] = await client.resolve("SummerSEO");
    expect(seoError).toBeNull();
    expect(seo).toMatchObject({ title: "x" });
  });

  it("HP-15: the bundled content stays in memory beside the live release", async () => {
    const api = deliveryApi();
    const content = await contentModule();
    const cms = createCMS({ blocks: docsBlocks(), content, site: SITE, token: TOKEN });
    api.publish(1, await hashed("Live"));
    await cms.update();
    expect(await titleOf(cms.forRelease())).toBe("Live");
    const downloads = api.assetFetches();
    api.point(2, content.revision); // roll back to what the build shipped
    await cms.update();
    expect(api.assetFetches()).toBe(downloads);
    expect(await cms.forRelease().revision()).toBe(content.revision);
  });

  it("HP-16: remoteLoader(content, { site, token }) is a loader whose load() reports the served revision", async () => {
    deliveryApi();
    const content = docsSnapshot();
    const connected = remoteLoader(content, { site: SITE, token: TOKEN }) as Loader;
    expect((await connected.load()).revision).toBe(content.revision);
    // The docs' troubleshooting snippet passes process.env values, which can be undefined.
    const env = { DECO_SITE: undefined, DECO_SITE_TOKEN: undefined } as Record<
      string,
      string | undefined
    >;
    const loader = remoteLoader(content, {
      site: env.DECO_SITE as string,
      token: env.DECO_SITE_TOKEN as string,
    });
    expect(typeof (loader as Loader).load).toBe("function");
  });

  it("HP-17: a server that hasn't fetched a release reports its fallback's revision", async () => {
    deliveryApi().fail(true);
    const content = await contentModule();
    const cms = createCMS({ blocks: docsBlocks(), content, site: SITE, token: TOKEN });
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

  it("HD-2: forDraft fetches that version once and serves it from memory afterwards", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    expect(api.draftFetches()).toHaveLength(2); // one manifest, one changed block
  });

  it("HD-3: a draft holds only changed blocks and deletions; every other block is inherited", async () => {
    const api = deliveryApi();
    const pointer = await api.draft({
      set: { SummerSEO: seoEntry("Draft") },
      delete: ["HelloWorld"],
    });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
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
    deliveryApi(); // no such overlay: 404
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    const client = cms.forDraft(`${HOST}/sites/acme/drafts?${GRANT}@${"a".repeat(64)}`);
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
    const POINTER = await api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
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

  it("HD-8: without site and token, forDraft reads the content module (no fetch, no error)", async () => {
    const api = deliveryApi();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    expect(await titleOf(cms.forDraft(POINTER))).toBe("Sunny!");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("HD-10: deco-draft is the cookie draftCookie writes and draftPointer reads", async () => {
    const set = await draftCookie(
      new Request(`https://s.example/?__draft=${encodeURIComponent(POINTER)}`),
    );
    expect(set?.startsWith(`${DRAFT_COOKIE}=`)).toBe(true);
  });

  it("HD-12: examples never spell __draft or deco-draft", () => {
    const examples = path.resolve(HERE, "../../../../../examples");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (/__draft|deco-draft/.test(text)) hits.push(full);
        }
      }
    };
    walk(examples);
    expect(hits).toEqual([]);
  });

  it("HD-13: forDraft takes only the pointer string (the React Native example)", async () => {
    const api = deliveryApi();
    const POINTER = await api.draft({ set: { SummerSEO: seoEntry("Mobile draft") } });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
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
      token: TOKEN,
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
      token: TOKEN,
    });
    for (const pointer of ["garbage", "https://x/y@1", "@1", `${HOST}/x@`]) {
      const [value, error] = await cms.forDraft(pointer).list("seo");
      expect(value).toBeNull();
      expect(error?.code).toBe("LOADER_FAILED");
    }
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("HD-18: preview hosts from the release's CMS block: a draft previews on staging only, every other host serves the release", async () => {
    const api = deliveryApi();
    // The draft tries to allow its own host: settings come from the release, so it can't.
    const POINTER = await api.draft({
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
    const cms = createCMS({ blocks: docsBlocks(), content: release, site: SITE, token: TOKEN });
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
    const cms = createCMS({ blocks: docsBlocks(), content: bundled(), site: SITE, token: TOKEN });
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
    api.publish(1, next);
    const cms = createCMS({ blocks: docsBlocks(), content: bundled(), site: SITE, token: TOKEN });
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
  it("HRI-3: update() runs on first use, then a manifest check every interval", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const api = deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    expect(api.manifestFetches()).toBe(0); // nothing at construction
    cms.forRelease();
    await flush();
    expect(api.manifestFetches()).toBe(1);
    now += 60_000;
    cms.forRelease();
    await flush();
    expect(api.manifestFetches()).toBe(2);
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

  it("HRI-6: a manifest older than the newest observed generation is ignored", async () => {
    const api = deliveryApi();
    const loader = remote(docsSnapshot());
    const five = await hashed("Five");
    api.publish(5, five);
    await loader.update?.();
    api.publish(4, await hashed("Four"));
    expect(await loader.update?.()).toEqual({ updated: false });
    expect((await loader.load()).revision).toBe(five.revision);
  });

  it("HRI-7: a same-revision manifest adopts its generation without downloading", async () => {
    const api = deliveryApi();
    const loader = remote(docsSnapshot());
    const r = await hashed("R");
    api.publish(5, r);
    await loader.update?.();
    const downloads = api.assetFetches();
    api.point(6, r.revision);
    await loader.update?.();
    expect(api.assetFetches()).toBe(downloads);
    api.publish(5, await hashed("Stale gen 5")); // older than the adopted 6
    await loader.update?.();
    expect((await loader.load()).revision).toBe(r.revision);
  });

  it("HRI-8: a snapshot that doesn't hash to its revision is rejected", async () => {
    const api = deliveryApi();
    const real = await hashed("Real");
    const tampered = { revision: real.revision, blocks: { Other: { __resolveType: "seo" } } };
    api.publish(1, real, tampered);
    const fallback = docsSnapshot();
    const loader = remote(fallback);
    await expect(loader.update?.()).rejects.toThrow(/doesn't match/);
    expect(await loader.load()).toBe(fallback);
  });

  it("HRI-8: a slower earlier check can't undo a newer promotion", async () => {
    const api = deliveryApi();
    const loader = remote(docsSnapshot());
    const one = await hashed("Gen 1");
    const two = await hashed("Gen 2");
    api.publish(1, one);
    const gate = api.gate(api.assetPath(one.revision));
    const slow = loader.update?.();
    for (let i = 0; i < 50 && api.assetFetches() === 0; i++) await flush(2);
    expect(api.assetFetches()).toBe(1);
    api.publish(2, two);
    await loader.update?.();
    gate.resolve();
    expect(await slow).toEqual({ updated: false });
    expect((await loader.load()).revision).toBe(two.revision);
  });

  it("HRI-9: a loader with its own revision scheme is downloaded once", async () => {
    const api = deliveryApi();
    const custom: Loader = { load: async () => docsSnapshot("my-own-scheme-1") };
    const loader = remote(custom);
    api.publish(1, await hashed("Hosted"));
    await loader.update?.();
    await loader.update?.();
    await loader.update?.();
    expect(api.assetFetches()).toBe(1);
  });

  it("HRI-10/HD-4: a draft that can't be fetched is LOADER_FAILED on every call; published content is never substituted", async () => {
    const api = deliveryApi();
    api.publish(1, await hashed("Release"));
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: SITE,
      token: TOKEN,
    });
    await cms.update();
    const unprepared = `${HOST}/sites/acme/drafts?${GRANT}@${"b".repeat(64)}`;
    const [value, error] = await cms.forDraft(unprepared).resolve("SummerSEO");
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

  it("HRI-12: the key is site, token and content identity, never the revision", async () => {
    const blocks = docsBlocks();
    const a = createCMS({
      blocks,
      content: { ...docsSnapshot("rev-1"), root: ".deco" },
      site: SITE,
      token: TOKEN,
    });
    const reloaded = createCMS({
      blocks,
      content: { ...docsSnapshot("rev-2"), root: ".deco" },
      site: SITE,
      token: TOKEN,
    });
    expect(reloaded).toBe(a);
    expect(await reloaded.forRelease().revision()).toBe("rev-2");
    const other = createCMS({
      blocks,
      content: { ...docsSnapshot("rev-2"), root: ".deco" },
      site: "other",
      token: TOKEN,
    });
    expect(other).not.toBe(a);
    const otherFolder = createCMS({
      blocks,
      content: { ...docsSnapshot("rev-2"), root: "apps/b/.deco" },
      site: SITE,
      token: TOKEN,
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
    const a = createCMS({ blocks: docsBlocks(), content, site: SITE, token: TOKEN });
    const loaderA = remoteLoader(content, { site: SITE, token: TOKEN });
    resetForTests();
    expect(createCMS({ blocks: docsBlocks(), content, site: SITE, token: TOKEN })).not.toBe(a);
    expect(remoteLoader(content, { site: SITE, token: TOKEN })).not.toBe(loaderA);
    expect(typeof (root as Record<string, unknown>).resetForTests).toBe("function");
  });
});
