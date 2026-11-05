// @vitest-environment node
/**
 * Docs conformance: content-delivery, draft-synchronization,
 * releases-and-deployment, hosted, hosted-publishing, hosted-drafts and
 * hosted-releases-internals (src/content/docs/en/storefront/blocks/next/*.mdx in
 * deco-sites/docs-tanstack), as the CMS-on-the-CDN design (2026-11-03) defines
 * them, with content-addressed blocks (2026-11-05): runtime-only content,
 * `sites/<site>/latest.json` (the revision index `{ revision, sequence,
 * blocks }` plus `previewHosts`), immutable `blocks/<hash>.json` bodies and
 * `revisions/<id>/index.json` on delivery.decocms.com, drafts as folders on
 * the CDN. Each test names the claim it checks (CD-*, RD-*, H-*, HP-*,
 * HD-*, HRI-*, DP-*). A failing test is a claim the code doesn't meet yet.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as root from "../../index";
import { computeContentRevision, sha256Hex } from "../../protocol/canonical";
import { indexEntry } from "../blockMeta";
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
import type { CMSError, Loader, RequestLike, Snapshot } from "../types";

/** cms.draftPointer and cms.draftCookie on a CMS whose code lets every host preview. */
const helpers = () =>
  createCMS({
    blocks: {},
    content: { revision: "draft-helpers", blocks: {} },
    preview: { hosts: ["*"] },
  });
const draftPointer = (request: RequestLike) => helpers().draftPointer(request);
const draftCookie = (request: RequestLike) => helpers().draftCookie(request);
const DRAFT_COOKIE = "__deco_draft";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://delivery.decocms.com";
const SITE = "acme";
const TOKEN = "site-token";
const SITE_PATH = "/sites/acme";
const LATEST_PATH = `${SITE_PATH}/latest.json`;
const LATEST_URL = `${ORIGIN}${LATEST_PATH}`;
const revisionPath = (revision: string) => `${SITE_PATH}/revisions/${revision}/index.json`;
/** A pointer string, for the cookie and parsing claims; drafts that load come from api.draft(). */
const POINTER = `${DRAFT_HOST}/sites/acme/drafts/summer-sale/index.json@9f3c1a`;
/** Where the fake CDN answers drafts. */
const DRAFTS = `https://${DRAFT_HOST}/sites/acme/drafts/`;

/** Content without a site: the docs' snapshot. */
const docsSnapshot = (revision?: string): Snapshot => unhashedSnapshot(revision);
/** The revision the fake CDN serves until a test publishes another: the docs' content. */
const DOCS_REV = "fe6c5e0d97f0-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a50";

const remote = () => remoteLoader(undefined, { site: SITE }) as Loader;
const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => resetForTests());
afterEach(async () => {
  await flush(50); // let background checks a test started finish against its own fetch stub
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetForTests();
});

/** A release as Studio publishes it: the blocks, under a revision id (`<inv>-<uuidv7>`) per title. */
async function hashed(title: string, extra: Record<string, unknown> = {}): Promise<Snapshot> {
  const blocks = { SummerSEO: { __resolveType: "seo", title, description: "d" }, ...extra };
  return { revision: revisionIdOf(await sha256Hex(title)), blocks };
}

/** A valid revision id made from hex digits. */
function revisionIdOf(h: string): string {
  return `${h.slice(0, 12)}-${h.slice(12, 20)}-${h.slice(20, 24)}-7${h.slice(25, 28)}-8${h.slice(29, 32)}-${h.slice(32, 44)}`;
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
 * A fake delivery CDN with the hosted layout (hosted-releases-internals):
 * `sites/acme/latest.json` (the revision index plus `previewHosts`, with an
 * ETag and 304s), `revisions/<id>/index.json`, immutable
 * `blocks/<hash>.json`, and draft folders (see testFixtures' fakeStudio). It
 * starts with the docs' content published as DOCS_REV, sequence 1.
 */
async function deliveryApi() {
  const drafts = fakeStudio();
  const objects = new Map<string, { body: unknown; etag: string }>();
  const gates = new Map<string, Deferred>();
  let failAll = false;
  let writes = 0;
  let sequence = 0;
  /** The site's addresses, as Studio writes them into latest.json; `undefined`: none written. */
  let hosts: string[] | undefined;
  let live: { revision: string; sequence: number; blocks: Record<string, unknown> } | undefined;
  const requests: { url: string; headers: Record<string, string>; init?: RequestInit }[] = [];
  const put = (p: string, body: unknown) => objects.set(p, { body, etag: `"e${++writes}"` });
  const answer = (p: string, headers: Record<string, string>): Response => {
    const object = objects.get(p);
    if (object === undefined) return new Response("not found", { status: 404 });
    // A Response is answered once as is (a stream); a function, with a new one each time.
    if (object.body instanceof Response) return object.body;
    if (typeof object.body === "function") return (object.body as () => Response)();
    if (headers["if-none-match"] === object.etag) {
      return new Response(null, { status: 304, headers: { etag: object.etag } });
    }
    return new Response(JSON.stringify(object.body), {
      headers: { "content-type": "application/json", etag: object.etag },
    });
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url, headers, init });
    if (failAll) throw new TypeError("fetch failed");
    if (!url.startsWith(ORIGIN)) return new Response("wrong host", { status: 599 });
    const p = url.slice(ORIGIN.length).split("?")[0] ?? "";
    // The CDN answers at once; a gated response only arrives late (what it says is fixed now).
    const response = url.startsWith(DRAFTS) ? await drafts.fetch(url, init) : answer(p, headers);
    const gate = gates.get(p)?.promise;
    if (gate) {
      // A fetch that waits ends when its signal does, as a real one (the loader's timeout).
      const signal = init?.signal;
      await Promise.race([
        gate,
        new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    }
    return response;
  });
  vi.stubGlobal("fetch", fetch);
  const writeLatest = () => {
    if (live === undefined) return;
    put(LATEST_PATH, { ...live, ...(hosts === undefined ? {} : { previewHosts: hosts }) });
  };
  /** Studio's publish: block objects, `revisions/<id>/index.json`, then `latest.json`. */
  const publish = async (snapshot: Snapshot, options: { sequence?: number } = {}) => {
    sequence = options.sequence ?? sequence + 1;
    const names = Object.keys(snapshot.blocks);
    const blocks: Record<string, unknown> = {};
    for (const name of names) {
      const entry = await indexEntry(name, snapshot.blocks[name], names);
      blocks[name] = entry;
      put(`${SITE_PATH}/blocks/${entry.version}.json`, snapshot.blocks[name]);
    }
    live = { revision: snapshot.revision, sequence, blocks };
    put(revisionPath(snapshot.revision), live);
    writeLatest();
    return live;
  };
  await publish({ revision: DOCS_REV, blocks: docsSnapshot().blocks });
  return {
    fetch,
    requests,
    publish,
    /** Studio's rollback ("Make current"): `revision`'s blocks under a new id, the next sequence. */
    async rollback(to: Snapshot, revision: string) {
      return publish({ revision, blocks: to.blocks });
    },
    /** A site that has published nothing: no `latest.json` (a 404). */
    unpublish() {
      objects.delete(LATEST_PATH);
    },
    /** The preview hosts Studio writes into `latest.json` from now on (and rewrites it with). */
    previewHosts(list: string[] | undefined) {
      hosts = list;
    },
    /** Rewrites `latest.json` for the live revision (the same sequence), with the hosts set now. */
    rewriteLatest() {
      writeLatest();
    },
    /** `latest.json` as is: a body, or a `Response` to answer with. */
    setLatest(value: unknown) {
      put(LATEST_PATH, value);
    },
    /** `latest.json` for the live revision, with these extra top-level fields. */
    patchLatest(extra: Record<string, unknown>) {
      put(LATEST_PATH, {
        ...live,
        ...(hosts === undefined ? {} : { previewHosts: hosts }),
        ...extra,
      });
    },
    /** The object at a path under the origin: a body, or a `Response` to answer with. */
    asset(p: string, body: unknown) {
      put(p, body);
    },
    /** Where a published name's body lives. */
    blockPath(name: string) {
      const entry = live?.blocks[name] as { version: string } | undefined;
      if (entry === undefined) throw new Error(`"${name}" isn't published`);
      return `${SITE_PATH}/blocks/${entry.version}.json`;
    },
    /** Saves a draft on the fake CDN; returns the pointer Studio would hand out. */
    draft: drafts.draft,
    /** Writes one draft file as is. */
    file: drafts.file,
    /** Answers every read of a draft's folder with this response instead (`null` stops). */
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
    /** Body and revision-index downloads (`blocks/` and `revisions/`). */
    assetFetches: () =>
      requests.filter((r) => /\/sites\/acme\/(blocks|revisions)\//.test(r.url)).length,
    latestFetches: () => requests.filter((r) => r.url === LATEST_URL).length,
  };
}
type DeliveryApi = Awaited<ReturnType<typeof deliveryApi>>;

/** The `ContentUnavailableError` reason (and status) behind a client's LOADER_FAILED. */
const unavailableOf = async (client: ReturnType<ReturnType<typeof createCMS>["forRelease"]>) => {
  const [value, error] = await client.resolve("SummerSEO");
  expect(value).toBeNull();
  expect(error?.code).toBe("LOADER_FAILED");
  const cause = (error as CMSError).cause as { name: string; reason: string; status?: number };
  expect(cause.name).toBe("ContentUnavailableError");
  return { reason: cause.reason, status: cause.status };
};

const titleOf = async (client: ReturnType<ReturnType<typeof createCMS>["forRelease"]>) => {
  const [entry, error] = await client.resolve<{ title: string }>("SummerSEO", { run: false });
  if (error) throw new Error(`${error.code}: ${error.message}`);
  return entry.title;
};

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

/**
 * The title the current index serves once its bodies are warm. The first read
 * after a publish may still pin the previous index (the page is in memory
 * there) while the new bodies are fetched in the background (A-19).
 */
const currentTitle = async (cms: ReturnType<typeof createCMS>) => {
  // The first read's background work (that warm) runs through the host hook,
  // so it is awaited itself: a timer-based flush can return before a loaded
  // machine runs it.
  const hook = Symbol.for("decocms.blocks.background");
  const g = globalThis as { [hook]?: (task: () => Promise<void>) => void };
  const installed = g[hook];
  const background: Promise<void>[] = [];
  g[hook] = (task) => void background.push(task());
  try {
    await titleOf(cms.forRelease());
  } finally {
    if (installed === undefined) delete g[hook];
    else g[hook] = installed;
  }
  await Promise.all(background);
  return titleOf(cms.forRelease());
};

// ---------------------------------------------------------------------------
// content-delivery.mdx
// ---------------------------------------------------------------------------

describe("content-delivery", () => {
  it("CD-1: the SDK never calls GitHub; releases come from the delivery origin, drafts from the pointer's host", async () => {
    for (const file of ["../remoteLoader.ts", "../draftChanges.ts", "../content.ts", "../cms.ts"]) {
      expect(fs.readFileSync(path.join(HERE, file), "utf8")).not.toMatch(/github/i);
    }
    const api = await deliveryApi();
    await api.publish(await hashed("Published"));
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    await cms.update();
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    const urls = api.requests.map((r) => r.url);
    // The draft's folder: its index, then the one file it names.
    expect(urls.filter((url) => url.startsWith(DRAFTS))).toEqual([
      `${DRAFTS}summer-sale/index.json`,
      `${DRAFTS}summer-sale/SummerSEO.json`,
    ]);
    // The first load, then the draft read's own check (DP-19); the draft's body is its own file.
    expect(urls.filter((url) => !url.startsWith(DRAFTS))).toEqual([LATEST_URL, LATEST_URL]);
  });

  it("CD-3: a content module's revision is the canonical content hash; a release's is its revision id", async () => {
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

  it("CD-4/CD-5/CD-6: reads /sites/<site>/latest.json, the revision's index, and each body it needs by hash", async () => {
    const api = await deliveryApi();
    const release = await hashed("Release C");
    api.previewHosts(["www.example.com"]);
    await api.publish(release);
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await titleOf(cms.forRelease())).toBe("Release C");
    expect(await cms.forRelease().revision()).toBe(release.revision);
    const hash = api.blockPath("SummerSEO");
    expect(hash).toMatch(/^\/sites\/acme\/blocks\/[A-Za-z0-9_-]{22}\.json$/);
    expect(api.requests.map((r) => r.url)).toEqual([LATEST_URL, `${ORIGIN}${hash}`]);
    expect(api.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
  });

  it("CD-7: refuses a latest.json that isn't a revision index (a revision id, a positive sequence, entries with hashes)", async () => {
    const release = await hashed("Evil");
    const bad = [
      {}, // no revision
      { revision: "../../other/revisions/x", sequence: 2, blocks: {} },
      { revision: `${release.revision}/../x`, sequence: 2, blocks: {} },
      { revision: "f".repeat(64), sequence: 2, blocks: {} }, // a content hash
      { revision: "1".repeat(40), schemaHash: "5".repeat(64), publishedAt: "x" }, // the git-SHA format
      { format: 1, generation: 1, revision: "1".repeat(40), snapshot: "/x.json" }, // v0 channels
      { revision: release.revision }, // the data.json layout's pointer: no sequence, no blocks
      { revision: release.revision, sequence: 0, blocks: {} },
      { revision: release.revision, sequence: 1.5, blocks: {} },
      { revision: release.revision, sequence: 2, blocks: [] },
      { revision: release.revision, sequence: 2, blocks: { SummerSEO: { version: "../x" } } },
    ];
    for (const value of bad) {
      resetForTests();
      const api = await deliveryApi();
      api.setLatest(value);
      const cms = createCMS({ blocks: docsBlocks(), site: SITE });
      expect(await unavailableOf(cms.forRelease())).toMatchObject({ reason: "format" });
      expect(api.assetFetches()).toBe(0);
    }
  });

  it("CD-8/CD-9: no schema gate: a higher-sequence index is swapped in, whatever else latest.json holds", async () => {
    const api = await deliveryApi();
    const one = await hashed("One");
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await titleOf(cms.forRelease())).toBe("Sunny!");
    await api.publish(one);
    api.patchLatest({ schemaHash: "6".repeat(64), publishedAt: "x" });
    expect(await cms.update()).toEqual({ updated: true });
    expect(await currentTitle(cms)).toBe("One");
    const sdk = fs.readFileSync(path.join(HERE, "../remoteLoader.ts"), "utf8");
    expect(sdk).not.toMatch(/schemaHash|committedAt|publishedAt/);
  });

  it("CD-10: an unchanged latest.json is a 304, and a body it holds is never downloaded again", async () => {
    const api = await deliveryApi();
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await titleOf(cms.forRelease())).toBe("Sunny!");
    expect(api.assetFetches()).toBe(1);
    expect(await cms.update()).toEqual({ updated: false });
    expect((await api.fetch.mock.results.at(-1)?.value)?.status).toBe(304);
    expect(api.requests.at(-1)?.headers["if-none-match"]).toBeDefined();
    expect(await titleOf(cms.forRelease())).toBe("Sunny!");
    expect(api.assetFetches()).toBe(1);
  });

  it("CD-11: a failing or malformed latest.json keeps the last good index; a body that can't be fetched fails that block alone", async () => {
    const api = await deliveryApi();
    const good = await hashed("Good");
    await api.publish(good);
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    await cms.update();
    expect(await titleOf(cms.forRelease())).toBe("Good");
    api.setLatest(() => new Response("boom", { status: 500 }));
    await expect(cms.update()).resolves.toEqual({ updated: false });
    api.setLatest({ revision: "not a revision id" });
    await expect(cms.update()).resolves.toEqual({ updated: false });
    expect(await titleOf(cms.forRelease())).toBe("Good");
    // A missing body (an index naming a hash the CDN lacks): that block is LOADER_FAILED.
    resetForTests();
    const other = await deliveryApi();
    other.asset(other.blockPath("SummerSEO"), () => new Response("not found", { status: 404 }));
    const fresh = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await unavailableOf(fresh.forRelease())).toEqual({ reason: "http", status: 404 });
    const [card, error] = await fresh.forRelease().resolve("SummerCard", { run: false });
    expect(error).toBeNull();
    expect(card).toMatchObject({ title: "Summer collection" });
  });

  it('CD-12: a rollback (Studio\'s "Make current") is a new revision with the next sequence, adopted; a stale latest.json with a lower sequence never is', async () => {
    const api = await deliveryApi();
    const a = await hashed("A");
    const b = await hashed("B");
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    await api.publish(a);
    await cms.update();
    expect(await currentTitle(cms)).toBe("A"); // A's body, held by its hash from now on
    await api.publish(b);
    await cms.update();
    expect(await currentTitle(cms)).toBe("B");
    const rollback = revisionIdOf(await sha256Hex("rollback to A"));
    const before = api.assetFetches();
    await api.rollback(a, rollback);
    expect(await cms.update()).toEqual({ updated: true });
    expect(await titleOf(cms.forRelease())).toBe("A");
    expect(await cms.forRelease().revision()).toBe(rollback);
    expect(api.assetFetches() - before).toBe(0); // A's body is still held, by its hash
    // A stale CDN answer (B again, under its old sequence) never moves the isolate back.
    await api.publish(b, { sequence: 3 });
    expect(await cms.update()).toEqual({ updated: false });
    expect(await titleOf(cms.forRelease())).toBe("A");
  });

  it("CD-16: the SDK bounds what it accepts: an oversized index or body stops downloading", async () => {
    const api = await deliveryApi();
    const latest = hugeBody(64);
    api.setLatest(new Response(latest.body));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await unavailableOf(cms.forRelease())).toMatchObject({ reason: "format" });
    // Rejected by a size bound (16 MiB), not after buffering and failing to parse all of it.
    expect(latest.state.pulled).toBeLessThanOrEqual(18);
    resetForTests();
    const other = await deliveryApi();
    const block = hugeBody(64);
    other.asset(other.blockPath("SummerSEO"), new Response(block.body));
    const fresh = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await unavailableOf(fresh.forRelease())).toMatchObject({ reason: "format" });
    expect(block.state.pulled).toBeLessThanOrEqual(18);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// content-delivery.mdx#draft-previews, hosted-drafts.mdx#who-may-preview:
// a draft pointer names Studio's API, which answers only the changes
// ---------------------------------------------------------------------------

describe("draft previews", () => {
  /** A CMS over the docs' content; with `site`, the same content from the fake CDN. */
  const cmsOf = (options: Partial<Parameters<typeof createCMS>[0]> = {}) =>
    createCMS({
      blocks: docsBlocks(),
      ...(options.site ? {} : { content: docsSnapshot() }),
      ...options,
    });
  const failed = async (client: ReturnType<ReturnType<typeof createCMS>["forDraft"]>) => {
    const [value, error] = await client.resolve("SummerSEO");
    const [list, listError] = await client.list("seo");
    return { value, code: error?.code, list, listCode: listError?.code };
  };
  const FAILED = { value: null, code: "LOADER_FAILED", list: null, listCode: "LOADER_FAILED" };

  it("DP-1: GET the folder's index.json, then each file it names: forced variants removed, no cookies or credentials", async () => {
    const api = await deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const withVariant = formatDraftPointer({
      ...parseDraftPointer(pointer)!,
      variants: [{ block: "Home", path: "", index: 1 }],
    });
    const cms = cmsOf({ site: SITE, token: TOKEN });
    expect(await titleOf(cms.forDraft(withVariant))).toBe("Draft");
    const requests = api.draftFetches();
    expect(requests.map((r) => r.url)).toEqual([
      `${DRAFTS}summer-sale/index.json`,
      `${DRAFTS}summer-sale/SummerSEO.json`,
    ]);
    for (const request of requests) {
      expect(request.headers).not.toHaveProperty("cookie");
      expect(request.headers).not.toHaveProperty("authorization"); // never the site token
      expect(request.headers).not.toHaveProperty("if-none-match"); // never revalidated
      expect(request.init?.credentials).not.toBe("include");
      expect(request.init?.redirect).toBe("manual");
    }
  });

  it("DP-2: set replaces production's block whole, delete removes it, every other block is production's", async () => {
    const api = await deliveryApi();
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
    const api = await deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = cmsOf({ site: SITE });
    const first = cms.forDraft(pointer);
    expect(await titleOf(first)).toBe("Draft");
    await api.publish(
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
    expect(api.draftFetches()).toHaveLength(4); // the index and its one file, per client
    expect(await next.revision()).not.toBe(await first.revision());
  });

  it("DP-4: the draft's revision is an opaque identity of the production revision and the version", async () => {
    const api = await deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const draft = cmsOf().forDraft(pointer);
    const revision = await draft.revision();
    expect(revision).toContain("rev-1");
    expect(revision).toContain("9f3c1a");
    expect(revision).not.toBe("rev-1");
    // A save is read by the next client, even under the same pointer: nothing is kept.
    api.draft({ set: { SummerSEO: seoEntry("Saved again") } });
    expect(await titleOf(cmsOf().forDraft(pointer))).toBe("Saved again");
    // Studio's next pointer names the save's version: another revision.
    const saved = api.draft({ set: { SummerSEO: seoEntry("Saved again") } }, { version: "a1b2c3" });
    expect(await cmsOf().forDraft(saved).revision()).not.toBe(revision);
  });

  it("DP-5: only *.decocms.com and loopback hosts by default; any other host, or a look-alike, is refused before anything is fetched", async () => {
    const api = await deliveryApi();
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
    const api = await deliveryApi();
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
        return Response.json({ names: [] });
      }),
    );
    const cms = cmsOf();
    const folder = "/sites/acme/drafts/x/index.json";
    for (const host of [
      "localhost:4000",
      "studio.localhost",
      "127.0.0.1:4000",
      "local.studio.decocms.com:4000",
      "studio.decocms.com",
      "pr-12.pr.studio.decocms.com",
    ]) {
      expect((await cms.forDraft(`${host}${folder}@v1`).revision()).endsWith("~v1")).toBe(true);
    }
    expect(urls).toEqual([
      `http://localhost:4000${folder}`,
      `http://studio.localhost${folder}`,
      `http://127.0.0.1:4000${folder}`,
      `https://local.studio.decocms.com:4000${folder}`,
      `https://studio.decocms.com${folder}`,
      `https://pr-12.pr.studio.decocms.com${folder}`,
    ]);

    // The defaults are v7's, which never listed the IPv6 loopback.
    urls.length = 0;
    expect(await failed(cms.forDraft(`[::1]:4000${folder}@v2`))).toEqual(FAILED);
    expect(urls).toEqual([]);
    // Configured, it is a loopback domain like the others: plain HTTP, any port.
    resetForTests();
    expect(
      (
        await cmsOf({ preview: { draftHosts: ["[::1]"] } })
          .forDraft(`[::1]:4000${folder}@v3`)
          .revision()
      ).endsWith("~v3"),
    ).toBe(true);
    expect(urls).toEqual([`http://[::1]:4000${folder}`]);
    // A pointer that names no draft folder is refused before anything is fetched.
    urls.length = 0;
    resetForTests();
    expect(await failed(cmsOf().forDraft("studio.decocms.com/changes?token=t@v4"))).toEqual(FAILED);
    expect(urls).toEqual([]);
  });

  it("DP-8: only a 200 (or a 304 to the ETag it sent) is accepted: an error status, or a redirect, is a failed draft", async () => {
    for (const status of [201, 204, 301, 302, 400, 401, 403, 404, 413, 500, 502]) {
      resetForTests();
      const api = await deliveryApi();
      const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
      api.respond("summer-sale", () =>
        status === 204
          ? new Response(null, { status })
          : new Response(JSON.stringify({ names: [] }), {
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
    const api = await deliveryApi();
    const pointer = api.draft({});
    const { body, state } = hugeBody(64);
    api.respond("summer-sale", () => new Response(body));
    expect(await failed(cmsOf().forDraft(pointer))).toEqual(FAILED);
    expect(state.pulled).toBeLessThanOrEqual(18);
    // A declared length over the limit isn't read at all.
    resetForTests();
    const declared = await deliveryApi();
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

  it("DP-11: the shape is checked: the index is { names }, each file a set (with data), delete or published operation", async () => {
    const indexes: unknown[] = [
      { names: {} },
      { names: "SummerSEO" },
      {},
      [],
      "names",
      null,
      "not json",
    ];
    for (const body of indexes) {
      resetForTests();
      const api = await deliveryApi();
      const pointer = api.draft({});
      api.respond("summer-sale", () =>
        body === "not json" ? new Response("{oops") : Response.json(body),
      );
      expect({ body, ...(await failed(cmsOf().forDraft(pointer))) }).toEqual({ body, ...FAILED });
    }
    // A name that isn't a string names no file: it is skipped.
    resetForTests();
    const skipped = await deliveryApi();
    const odd = skipped.draft({});
    skipped.respond("summer-sale", () => Response.json({ names: [1] }));
    expect(await titleOf(cmsOf().forDraft(odd))).toBe("Sunny!");
    const files: unknown[] = [
      { operation: "set" },
      { operation: "set", data: "x" },
      { operation: "rename", data: seoEntry("x") },
      { set: { SummerSEO: seoEntry("x") }, delete: [] }, // the old one-file shape
      [],
      "set",
      null,
    ];
    for (const body of files) {
      resetForTests();
      const api = await deliveryApi();
      const pointer = api.draft({});
      api.file("summer-sale", "SummerSEO", body);
      expect({ body, ...(await failed(cmsOf().forDraft(pointer))) }).toEqual({ body, ...FAILED });
    }
  });

  it("DP-11b: other keys (Studio's editor: who changed the block, and when) are ignored; a published marker or a missing file is no change", async () => {
    const api = await deliveryApi();
    const pointer = api.draft({});
    api.file("summer-sale", "SummerSEO", {
      operation: "set",
      data: seoEntry("Draft"),
      user: "usr_123",
      via: "studio",
      at: 1793800000,
      future: { anything: true },
    });
    api.file("summer-sale", "HelloWorld", { operation: "delete", user: "usr_456", at: 1793800100 });
    api.file("summer-sale", "SummerCard", { operation: "published", revision: DOCS_REV });
    api.file("summer-sale", "LegacySummer", undefined); // named by the index, 404
    const draft = cmsOf().forDraft(pointer);
    expect(await titleOf(draft)).toBe("Draft");
    expect((await draft.resolve("HelloWorld"))[1]?.code).toBe("NOT_FOUND");
    expect((await draft.resolve("SummerCard", { run: false }))[0]).toMatchObject({
      title: "Summer collection",
    });
    expect((await draft.resolve("LegacySummer", { run: false }))[1]).toBeNull();
  });

  it("DP-12: a failed draft is LOADER_FAILED on every call, never published content, and isn't reused", async () => {
    const api = await deliveryApi();
    await api.publish(await hashed("Release"));
    const cms = cmsOf({ site: SITE });
    await cms.update();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Back") } });
    api.respond("summer-sale", () => new Response("bad gateway", { status: 502 }));
    const client = cms.forDraft(pointer);
    expect(await failed(client)).toEqual(FAILED);
    await expect(client.revision()).rejects.toMatchObject({ code: "LOADER_FAILED" });
    const [, error] = await client.resolve("SummerSEO");
    expect(String((error?.cause as Error | undefined)?.message)).toContain("HTTP 502");
    expect(api.draftFetches()).toHaveLength(1); // one read per client: its index
    api.respond("summer-sale", null);
    expect(await titleOf(cms.forDraft(pointer))).toBe("Back");
    expect(api.draftFetches()).toHaveLength(3);
  });

  it("DP-13: a draft that isn't there (a wrong or deleted slug) gets no content", async () => {
    const api = await deliveryApi();
    api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const wrong = `${DRAFT_HOST}/sites/acme/drafts/guessed/index.json@9f3c1a`;
    expect(await failed(cmsOf().forDraft(wrong))).toEqual(FAILED);
    expect(api.draftFetches()).toHaveLength(1);
  });

  it("DP-14: every client reads the draft afresh, with no If-None-Match, so a save shows on the next request", async () => {
    const api = await deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("a") } }, { slug: "a" });
    const cms = cmsOf();
    expect(await titleOf(cms.forDraft(pointer))).toBe("a");
    expect(await titleOf(cms.forDraft(pointer))).toBe("a");
    expect(api.draftFetches()).toHaveLength(4);
    for (const r of api.draftFetches()) expect(r.headers["if-none-match"]).toBeUndefined();
    api.draft({ set: { SummerSEO: seoEntry("a, saved") } }, { slug: "a" });
    expect(await titleOf(cms.forDraft(pointer))).toBe("a, saved");
    // Concurrent drafts never see each other's files.
    const b = api.draft({ set: { SummerSEO: seoEntry("b") } }, { slug: "b" });
    const [ta, tb] = await Promise.all([titleOf(cms.forDraft(pointer)), titleOf(cms.forDraft(b))]);
    expect([ta, tb]).toEqual(["a, saved", "b"]);
  });

  it("DP-14b: a 304 to a request that sent no ETag is a failed draft", async () => {
    const api = await deliveryApi();
    const pointer = api.draft({});
    api.respond("summer-sale", () => new Response(null, { status: 304 }));
    expect(await failed(cmsOf().forDraft(pointer))).toEqual(FAILED);
  });

  it("DP-15: drafts need no site or token, and never send them", async () => {
    const api = await deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    expect(await titleOf(cmsOf().forDraft(pointer))).toBe("Draft");
    expect(api.requests.map((r) => r.url.startsWith(DRAFTS))).toEqual([true, true]);
    resetForTests();
    const hosted = await deliveryApi();
    const hostedPointer = hosted.draft({ set: { SummerSEO: seoEntry("Draft") } });
    expect(await titleOf(cmsOf({ site: SITE, token: TOKEN }).forDraft(hostedPointer))).toBe(
      "Draft",
    );
    for (const r of hosted.draftFetches()) expect(r.headers.authorization).toBeUndefined();
  });

  it("DP-16: a pointer whose version is local names no draft: nothing is fetched, forced variants apply", async () => {
    const api = await deliveryApi();
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

  it("DP-17: forced variants apply on top of the draft's changes; every variant reads the same files", async () => {
    const api = await deliveryApi();
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
    const urls = api.draftFetches().map((r) => r.url);
    expect(new Set(urls)).toEqual(
      new Set([`${DRAFTS}summer-sale/index.json`, `${DRAFTS}summer-sale/Banner.json`]),
    );
    expect(urls).toHaveLength(6);
  });

  it("DP-18: empty changes (a draft before its first change) show production", async () => {
    const api = await deliveryApi();
    const pointer = api.draft({}, { slug: "not-saved-yet" });
    const cms = cmsOf();
    expect(await titleOf(cms.forDraft(pointer))).toBe("Sunny!");
    const [pages] = await cms.forDraft(pointer).list("page");
    expect(pages).toHaveLength(2);
  });

  const posted = (name: string) => ({
    HelloWorld: { __resolveType: "post", name, path: "/x", date: "2026-10-02" },
  });
  const postNames = (read: readonly [{ name: string }[] | null, unknown]) =>
    read[0]?.map((post) => post.name);

  it("DP-19: a draft read first checks for a new release and waits for it: an isolate holding release A whose latest.json moved to B renders the draft over B on the first request", async () => {
    const api = await deliveryApi();
    const a = await hashed("Release A", posted("A"));
    await api.publish(a);
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = cmsOf({ site: SITE });
    await cms.update();
    expect(await cms.forRelease().revision()).toBe(a.revision); // the isolate holds A
    const b = await hashed("Release B", posted("B"));
    await api.publish(b); // Publish: latest.json names B; this isolate hasn't checked yet
    const draft = cms.forDraft(pointer);
    expect(await titleOf(draft)).toBe("Draft");
    expect(postNames(await draft.list<{ name: string }>("post"))).toEqual(["B"]);
    expect(await draft.revision()).toContain(b.revision);
    // Swapped in as the background check swaps a release: the next visitor gets B too.
    expect(await cms.forRelease().revision()).toBe(b.revision);
  });

  it("DP-19b: concurrent draft reads share one check; a read arriving while a check is in flight waits for the next one", async () => {
    const api = await deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = cmsOf({ site: SITE });
    await cms.update(); // the first load: the docs' release
    const before = api.latestFetches();
    const a = await hashed("Release A", posted("A"));
    await api.publish(a);
    const download = api.gate(LATEST_PATH); // the first check's answer (A) is slow to arrive
    const first = cms.forDraft(pointer).list<{ name: string }>("post");
    await flush();
    expect(api.latestFetches() - before).toBe(1);
    const b = await hashed("Release B", posted("B"));
    await api.publish(b); // published while that check runs: it can't see B
    const burst = [1, 2, 3].map(() => cms.forDraft(pointer).list<{ name: string }>("post"));
    await flush();
    expect(api.latestFetches() - before).toBe(1); // the burst waits for the next check
    download.resolve();
    expect(postNames(await first)).toEqual(["A"]);
    for (const read of burst) expect(postNames(await read)).toEqual(["B"]);
    expect(api.latestFetches() - before).toBe(2); // one check for the whole burst
  });

  it("DP-19c: a failed or hanging check never fails the draft: after the timeout it renders over the release held", async () => {
    const api = await deliveryApi();
    const a = await hashed("Release A", posted("A"));
    await api.publish(a);
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = cmsOf({ site: SITE });
    await cms.update();
    // Failing: latest.json answers 503.
    api.setLatest(() => new Response("unavailable", { status: 503 }));
    const failing = cms.forDraft(pointer);
    expect(await titleOf(failing)).toBe("Draft");
    expect(postNames(await failing.list<{ name: string }>("post"))).toEqual(["A"]);
    // Hanging: the check waits until the loader's fetch timeout ends it.
    const timeouts: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      timeouts.push(controller);
      return controller.signal;
    });
    await api.publish(await hashed("Release B", posted("B")));
    api.gate("/sites/acme/latest.json"); // never answers
    const read = cms.forDraft(pointer).list<{ name: string }>("post");
    expect(await Promise.race([read.then(() => "rendered"), flush(50).then(() => "waiting")])).toBe(
      "waiting",
    );
    for (const controller of timeouts) {
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    }
    expect(postNames(await read)).toEqual(["A"]);
  });

  it("DP-19d: one draft request, one check: its host check, the binding's read of the draft and the render share cms.checkRelease()'s check, so the request reads latest.json once", async () => {
    const api = await deliveryApi();
    api.previewHosts(["staging.example.com"]);
    await api.publish(await hashed("Release A", posted("A")));
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = cmsOf({ site: SITE });
    await cms.update();
    await api.publish(await hashed("Release B", posted("B"))); // Publish: this isolate holds A
    const before = api.latestFetches();
    const request = new Request(
      `https://staging.example.com/?__draft=${encodeURIComponent(pointer)}`,
    );
    // What a binding does for one preview request.
    const releaseCheck = await cms.checkRelease();
    expect((await cms.readVersion(request, { releaseCheck }))?.version).toBe(pointer);
    await cms.forDraft(pointer, { releaseCheck }).revision();
    const render = cms.client({ version: pointer, releaseCheck });
    expect(postNames(await render.list<{ name: string }>("post"))).toEqual(["B"]);
    expect(await titleOf(cms.forDraft(pointer, { releaseCheck }))).toBe("Draft");
    expect(api.latestFetches() - before).toBe(1);
    // The next request checks again: no time-based throttle.
    const next = await cms.checkRelease();
    expect(next).not.toBe(releaseCheck);
    expect(api.latestFetches() - before).toBe(2);
    // Given the id of a check it made (a proxy's, for the same request), it waits for that one.
    expect(await cms.checkRelease(next)).toBe(next);
    expect(api.latestFetches() - before).toBe(2);
    // An id it didn't make (another process's) is a check of its own.
    await cms.forDraft(pointer, { releaseCheck: "another-process:1" }).revision();
    expect(api.latestFetches() - before).toBe(3);
  });

  it("DP-20: an entry named __proto__ in set stays an entry", async () => {
    const api = await deliveryApi();
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
    const changes = { names: [] };
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
      const api = await deliveryApi();
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
    const api = await deliveryApi();
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

  it("H-4/HRI-1: with site, a cold start while delivery is unreachable answers LOADER_FAILED; the site decides", async () => {
    const api = await deliveryApi();
    api.fail(true);
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await unavailableOf(cms.forRelease())).toEqual({ reason: "network", status: undefined });
    const [list, error] = await cms.forRelease().list("seo");
    expect(list).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
    await expect(cms.forRelease().revision()).rejects.toMatchObject({ code: "LOADER_FAILED" });
    await expect(cms.update()).resolves.toEqual({ updated: false });
    // Delivery answers again: the next request loads.
    api.fail(false);
    expect(await titleOf(cms.forRelease())).toBe("Sunny!");
  });

  it("H-5: no development rule: NODE_ENV=development serves and follows releases like production", async () => {
    for (const env of ["development", "production", undefined]) {
      resetForTests();
      vi.stubEnv("NODE_ENV", env);
      const api = await deliveryApi();
      const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
      const cms = createCMS({ blocks: docsBlocks(), site: SITE });
      expect(await titleOf(cms.forRelease()), String(env)).toBe("Sunny!");
      await api.publish(await hashed("Published"));
      await expect(cms.update(), String(env)).resolves.toEqual({ updated: true });
      expect(await currentTitle(cms)).toBe("Published");
      expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    }
    const sdk = fs.readFileSync(path.join(HERE, "../cms.ts"), "utf8");
    expect(sdk).not.toMatch(/NODE_ENV|isDevelopment/);
  });

  it("H-6: site alone never sends telemetry; site reads no environment variable", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otel.example.com");
    vi.stubEnv("DECO_SITE_TOKEN", TOKEN);
    const api = await deliveryApi();
    await api.publish(await hashed("Published"));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
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
  it("HP-1/HRI-2: once a release is held, requests read memory and never wait for a pending check", async () => {
    const api = await deliveryApi();
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await titleOf(cms.forRelease())).toBe("Sunny!");
    const hang = new Promise<Response>(() => {});
    api.fetch.mockImplementation(() => hang);
    const fetch = api.fetch;
    void cms.update(); // a check that never finishes
    const client = cms.forRelease();
    const result = await Promise.race([client.list("seo"), flush(200).then(() => "timeout")]);
    expect(result).not.toBe("timeout");
    expect(fetch).toHaveBeenCalled();
  });

  it("HP-2: a release swaps in for the next client; clients already reading keep their revision", async () => {
    const api = await deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
      site: SITE,
    });
    const before = cms.forRelease();
    expect(await titleOf(before)).toBe("Sunny!");
    await api.publish(await hashed("New release"));
    await cms.update();
    expect(await titleOf(before)).toBe("Sunny!");
    expect(await currentTitle(cms)).toBe("New release");
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
    const api = await deliveryApi();
    api.fail(true);
    const cms = createCMS({
      blocks: docsBlocks(),
      site: SITE,
    });
    await expect(cms.update()).resolves.toEqual({ updated: false });
    api.fail(false);
    await api.publish(await hashed("Now"));
    // Nothing held yet: the check is the first load, and reports no swap.
    await expect(cms.update()).resolves.toEqual({ updated: false });
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
    const api = await deliveryApi();
    await api.publish(await hashed("Once"));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    await cms.update();
    const assets = api.assetFetches();
    await cms.update();
    await cms.update();
    expect(api.assetFetches()).toBe(assets);
    expect(api.latestFetches()).toBe(3);
  });

  it("HP-10: a network error or an unparseable index leaves memory as it was", async () => {
    const api = await deliveryApi();
    const good = await hashed("Good");
    await api.publish(good);
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    await cms.update();
    api.setLatest(() => new Response("{not json", { status: 200 }));
    await expect(cms.update()).resolves.toEqual({ updated: false });
    api.fail(true);
    await expect(cms.update()).resolves.toEqual({ updated: false });
    api.fail(false);
    expect(await titleOf(cms.forRelease())).toBe("Good");
  });

  it("HP-11: a client never mixes entries from two revisions", async () => {
    const api = await deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
      site: SITE,
    });
    const client = cms.forRelease();
    const [first] = await client.list("seo");
    await api.publish(
      await hashed("New", { Other: { __resolveType: "seo", title: "o", description: "o" } }),
    );
    await cms.update();
    const [second] = await client.list("seo");
    expect(second).toEqual(first);
    expect(await client.revision()).toBe(DOCS_REV);
  });

  it("HP-13: a type the deployed code lacks fails that block with UNKNOWN_BLOCK", async () => {
    const api = await deliveryApi();
    await api.publish(
      await hashed("x", { NewBanner: { __resolveType: "brand-new-banner", title: "t" } }),
    );
    const cms = createCMS({
      blocks: docsBlocks(),
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

  it("HP-16: remoteLoader(undefined, { site }) is a hosted source read by index (its load() rejects); without a site it is a plain loader over content", async () => {
    await deliveryApi();
    const connected = remote();
    await expect(connected.load()).rejects.toMatchObject({ code: "LOADER_FAILED" });
    const cms = createCMS({ blocks: docsBlocks(), content: connected });
    expect(await cms.forRelease().revision()).toBe(DOCS_REV);
    // The site reads its own env and passes it; an unset value is a plain loader over content.
    const env = { DECO_SITE: undefined } as Record<string, string | undefined>;
    const content = docsSnapshot();
    const loader = remoteLoader(content, { site: env.DECO_SITE as string });
    expect(await (loader as Loader).load()).toBe(content);
    expect((loader as Loader).update).toBeUndefined();
  });

  it("HP-17: a server that hasn't fetched a release has none to report: revision() rejects", async () => {
    (await deliveryApi()).fail(true);
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    await expect(cms.forRelease().revision()).rejects.toMatchObject({ code: "LOADER_FAILED" });
    const sdk = fs.readFileSync(path.join(HERE, "../remoteLoader.ts"), "utf8");
    expect(sdk).not.toMatch(/fallback/i);
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

  it("HD-2: forDraft reads the draft afresh for every client; nothing of it is kept", async () => {
    const api = await deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    expect(api.draftFetches()).toHaveLength(4);
    expect(api.draftFetches().every((r) => r.headers["if-none-match"] === undefined)).toBe(true);
  });

  it("HD-3: a draft holds only changed blocks and deletions; every other block is inherited", async () => {
    const api = await deliveryApi();
    const pointer = api.draft({
      set: { SummerSEO: seoEntry("Draft") },
      delete: ["HelloWorld"],
    });
    const cms = createCMS({
      blocks: docsBlocks(),
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
    await deliveryApi(); // the token in POINTER isn't the one the fake Studio signed: 401
    const cms = createCMS({
      blocks: docsBlocks(),
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
    const api = await deliveryApi();
    const POINTER = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({
      blocks: docsBlocks(),
      site: SITE,
      preview: { hosts: ["s.example"] },
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
    const api = await deliveryApi();
    const pointer = api.draft({ set: { SummerSEO: seoEntry("Draft") } });
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    expect(await titleOf(cms.forDraft(pointer))).toBe("Draft");
    // The draft's folder only: no latest.json (no site), every request to the draft's host.
    expect(api.requests.map((r) => r.url.startsWith(DRAFTS))).toEqual([true, true]);
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
    const api = await deliveryApi();
    const POINTER = api.draft({ set: { SummerSEO: seoEntry("Mobile draft") } });
    const cms = createCMS({
      blocks: docsBlocks(),
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
    const api = await deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
      site: SITE,
    });
    const [value, error] = await cms.forDraft("evil.example/x?token=t@1").resolve("SummerSEO");
    expect(value).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
    expect(api.requests.filter((r) => r.url.includes("evil.example"))).toEqual([]);
  });

  it("HD-16: a malformed pointer loads nothing and returns an error", async () => {
    const api = await deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
      site: SITE,
    });
    for (const pointer of ["garbage", "https://x/y@1", "@1", `${DRAFT_HOST}/x@`]) {
      const [value, error] = await cms.forDraft(pointer).list("seo");
      expect(value).toBeNull();
      expect(error?.code).toBe("LOADER_FAILED");
    }
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("HD-18: preview hosts from the release metadata: a draft previews on staging only, every other host serves the release", async () => {
    const api = await deliveryApi();
    // The draft tries to allow its own host: hosts come from the release metadata, so it can't.
    const POINTER = api.draft({
      set: {
        SummerSEO: seoEntry("Preview"),
        CMS: { __resolveType: "cms-settings", preview: { hosts: ["*"] } },
      },
    });
    api.previewHosts(["staging.store.example.com"]);
    api.rewriteLatest(); // Studio's metadata, written with the release
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    const pick = async (request: Request) => {
      const pointer = await cms.draftPointer(request);
      const cookie = await cms.draftCookie(request);
      return { client: pointer ? cms.forDraft(pointer) : cms.forRelease(), cookie };
    };
    const q = `?__draft=${encodeURIComponent(POINTER)}`;
    const staging = await pick(new Request(`https://staging.store.example.com/${q}`));
    expect(await titleOf(staging.client)).toBe("Preview");
    expect(staging.cookie).not.toBeNull();
    // A preview of that draft doesn't change the hosts either.
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
// releases-and-drafts.mdx › where a site can be previewed (PO 2026-10-22)
// ---------------------------------------------------------------------------

describe("preview hosts in the release metadata", () => {
  const link = (host: string, version = POINTER) =>
    new Request(`https://${host}/?__draft=${encodeURIComponent(version)}`);

  it("PH-1: Studio writes previewHosts into latest.json; previews are honoured only on those hosts, wildcards included", async () => {
    const api = await deliveryApi();
    api.previewHosts(["staging.example.com", "*.deco.site", "localhost"]);
    await api.publish(await hashed("Published"));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    // A request that asks for no preview reads no metadata.
    expect(await cms.readVersion(new Request("https://www.example.com/"))).toBeNull();
    expect(api.latestFetches()).toBe(0);
    // The first preview request reads latest.json (only it, once) before answering.
    for (const host of ["staging.example.com", "acme.deco.site", "localhost:5173"]) {
      expect(await cms.draftPointer(link(host)), host).toBe(POINTER);
    }
    for (const host of ["www.example.com", "deco.site", "staging.example.com.attacker.com"]) {
      expect(await cms.draftPointer(link(host)), host).toBeNull();
      expect(await cms.draftCookie(link(host)), host).toBeNull();
    }
    expect(api.latestFetches()).toBe(1);
    expect(api.assetFetches()).toBe(0);
    expect((await cms.settings()).preview.hosts).toEqual([
      "staging.example.com",
      "*.deco.site",
      "localhost",
    ]);
    // The background check keeps them current: Studio changes the site's addresses on the next publish.
    api.previewHosts(["www.example.com"]);
    await api.publish(await hashed("Next"));
    // The preview request's read of latest.json held the first index; this one is newer.
    expect(await cms.update()).toEqual({ updated: true });
    expect(await cms.draftPointer(link("www.example.com"))).toBe(POINTER);
    expect(await cms.draftPointer(link("staging.example.com"))).toBeNull();
  });

  it("PH-2: an empty list in the metadata (and none in code) allows no host, never an error", async () => {
    const api = await deliveryApi();
    api.previewHosts([]);
    await api.publish(await hashed("Published"));
    // The CMS block's preview field, an earlier version's, doesn't count either.
    await api.publish(
      await hashed("Published", {
        CMS: { __resolveType: "cms-settings", preview: { hosts: ["*"] } },
      }),
    );
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await cms.readVersion(link("staging.example.com"))).toBeNull();
    expect(await cms.draftCookie(link("staging.example.com"))).toBeNull();
    expect((await cms.settings()).preview.hosts).toEqual([]);
    // Ending a preview still works on any host.
    expect(await cms.draftCookie(new Request("https://staging.example.com/?__draft=off"))).toMatch(
      /Max-Age=0/,
    );
    expect(await titleOf(cms.forRelease())).toBe("Published");
  });

  it("PH-3: a release id preview, like a draft, is checked against the current release's hosts, not the old release's", async () => {
    const api = await deliveryApi();
    api.previewHosts(["old.example.com"]);
    const old = await hashed("Old");
    await api.publish(old);
    api.previewHosts(["new.example.com"]);
    await api.publish(await hashed("Current"));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await cms.readVersion(link("old.example.com", old.revision))).toBeNull();
    const read = await cms.readVersion(link("new.example.com", old.revision));
    expect(read).toEqual({ version: old.revision });
    // The old release itself carries its own list; reading it changes nothing.
    expect(await titleOf(cms.client({ version: old.revision }))).toBe("Old");
    expect(await cms.readVersion(link("old.example.com", old.revision))).toBeNull();
  });

  it("PH-4: the hosts of the last latest.json read count before its revision is downloaded", async () => {
    const api = await deliveryApi();
    api.previewHosts(["staging.example.com"]);
    await api.publish(await hashed("Published"));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await cms.draftPointer(link("staging.example.com"))).toBe(POINTER);
    expect(await cms.draftPointer(link("www.example.com"))).toBeNull();
    expect(api.assetFetches()).toBe(0);
    expect(await titleOf(cms.forRelease())).toBe("Published");
  });

  it("PH-5: with no remote site, previews are allowed on every host, unless createCMS's preview.hosts lists hosts; with a site, that list adds to the release's", async () => {
    // Bundled content, no site, no list: every host, no fetch.
    const api = await deliveryApi();
    const open = createCMS({ blocks: docsBlocks(), content: unhashedSnapshot() });
    for (const host of ["localhost:3000", "staging.example.com", "www.example.com"]) {
      expect(await open.draftPointer(link(host)), host).toBe(POINTER);
    }
    expect((await open.settings()).preview.hosts).toEqual(["*"]);
    expect(api.latestFetches()).toBe(0);
    // No site, code lists hosts: that list is enforced.
    resetForTests();
    const local = createCMS({
      blocks: docsBlocks(),
      content: unhashedSnapshot(),
      preview: { hosts: ["localhost"] },
    });
    expect(await local.draftPointer(link("localhost:3000"))).toBe(POINTER);
    expect(await local.draftPointer(link("staging.example.com"))).toBeNull();
    expect(await local.draftCookie(link("staging.example.com"))).toBeNull();
    expect((await local.settings()).preview.hosts).toEqual(["localhost"]);
    // With a site and a list in the metadata, both lists count.
    resetForTests();
    const hostedApi = await deliveryApi();
    hostedApi.previewHosts(["staging.example.com"]);
    await hostedApi.publish(await hashed("Published"));
    const hosted = createCMS({
      blocks: docsBlocks(),
      site: SITE,
      preview: { hosts: ["localhost"] },
    });
    expect(await hosted.draftPointer(link("localhost:3000"))).toBe(POINTER);
    expect(await hosted.draftPointer(link("staging.example.com"))).toBe(POINTER);
    expect(await hosted.draftPointer(link("www.example.com"))).toBeNull();
  });

  it("PH-7: a site with no latest.json on the CDN (not published yet) previews on every host", async () => {
    for (const code of [undefined, ["localhost"]]) {
      resetForTests();
      const api = await deliveryApi();
      api.unpublish(); // nothing published: latest.json is a 404
      const cms = createCMS({
        blocks: docsBlocks(),
        site: SITE,
        ...(code ? { preview: { hosts: code } } : {}),
      });
      for (const host of ["staging.example.com", "www.example.com", "localhost:5173"]) {
        expect(await cms.draftPointer(link(host)), `${host} ${code}`).toBe(POINTER);
        expect(await cms.draftCookie(link(host)), host).not.toBeNull();
      }
      expect(api.latestFetches()).toBe(1);
      expect((await cms.settings()).preview.hosts).toEqual(["*"]);
      // Ending a preview still works.
      expect(await cms.draftCookie(new Request("https://www.example.com/?__draft=off"))).toMatch(
        /Max-Age=0/,
      );
      // Nothing to serve: the release is LOADER_FAILED (a 404), never an empty one.
      expect(await unavailableOf(cms.forRelease())).toEqual({ reason: "http", status: 404 });
      await flush(); // the first use's background check, before the next fake CDN
    }
  });

  it("PH-8: a latest.json without previewHosts (published before Studio wrote the list) counts as no list: every host, until a publish writes one", async () => {
    const api = await deliveryApi();
    api.previewHosts(undefined);
    await api.publish(await hashed("Published"));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    for (const host of ["staging.example.com", "www.example.com"]) {
      expect(await cms.draftPointer(link(host)), host).toBe(POINTER);
    }
    expect((await cms.settings()).preview.hosts).toEqual(["*"]);
    // The next publish writes the list: from then on it's enforced.
    api.previewHosts(["staging.example.com"]);
    await api.publish(await hashed("Next"));
    // The preview request's read of latest.json held the first index; this one is newer.
    expect(await cms.update()).toEqual({ updated: true });
    expect(await cms.draftPointer(link("staging.example.com"))).toBe(POINTER);
    expect(await cms.draftPointer(link("www.example.com"))).toBeNull();
    expect(await cms.draftCookie(link("www.example.com"))).toBeNull();
  });

  it("PH-9: a failed read of latest.json isn't a missing one: previews stay closed, and a later read retries", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const failures: [string, (api: DeliveryApi) => void][] = [
      ["network error", (api) => api.fail(true)],
      ["5xx", (api) => api.setLatest(() => new Response("unavailable", { status: 503 }))],
      ["malformed", (api) => api.setLatest({ revision: "not a revision id" })],
    ];
    for (const [label, fail] of failures) {
      resetForTests();
      const api = await deliveryApi();
      fail(api);
      const cms = createCMS({ blocks: docsBlocks(), site: SITE });
      expect(await cms.draftPointer(link("staging.example.com")), label).toBeNull();
      expect(await cms.draftCookie(link("staging.example.com")), label).toBeNull();
      expect((await cms.settings()).preview.hosts, label).toEqual([]);
      // The release can't load either (LOADER_FAILED), nothing rejects, and ending a preview works.
      expect((await cms.forRelease().resolve("SummerSEO"))[1]?.code).toBe("LOADER_FAILED");
      expect(
        await cms.draftCookie(new Request("https://staging.example.com/?__draft=off")),
      ).toMatch(/Max-Age=0/);
      // Delivery answers again: after the pause, the next preview request reads it.
      const published = await hashed("Published");
      api.previewHosts(["staging.example.com"]);
      await api.publish(published);
      api.fail(false);
      now += 10_000;
      expect(await cms.draftPointer(link("staging.example.com")), label).toBe(POINTER);
      expect(await cms.draftPointer(link("www.example.com")), label).toBeNull();
    }
  });

  it("PH-10: once this process has read a list, a 404 for latest.json is a failed read: the list stays enforced", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const api = await deliveryApi();
    api.previewHosts(["staging.example.com"]);
    await api.publish(await hashed("Published"));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await cms.draftPointer(link("www.example.com"))).toBeNull();
    // The CDN answers 404 for a published site (a fault): the list read before still applies.
    api.setLatest(() => new Response("not found", { status: 404 }));
    now += 120_000;
    expect(await cms.update()).toEqual({ updated: false });
    expect(await cms.draftPointer(link("www.example.com"))).toBeNull();
    expect(await cms.draftPointer(link("staging.example.com"))).toBe(POINTER);
    expect((await cms.settings()).preview.hosts).toEqual(["staging.example.com"]);
  });
});

// ---------------------------------------------------------------------------
// api-reference.mdx › cms.settings() with hosted releases
// ---------------------------------------------------------------------------

describe("CMS settings from hosted releases", () => {
  const withSettings = (title: string, collector: string) =>
    hashed(title, { CMS: { __resolveType: "cms-settings", analytics: { collector } } });

  it("S-1: before the first load, settings are the defaults, with no fetch; offline, previews stay closed", async () => {
    const api = await deliveryApi();
    api.fail(true);
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    const settings = await cms.settings();
    expect(settings.preview.hosts).toEqual([]);
    expect(settings.analytics.collector).toBe(HOSTED_ANALYTICS_COLLECTOR);
    expect(api.fetch).not.toHaveBeenCalled();
    // No preview hosts while delivery can't be reached: nothing rejects.
    const link = `?__draft=${encodeURIComponent("delivery.decocms.com/x@v")}`;
    expect(await cms.draftPointer(new Request(`https://www.example.com/${link}`))).toBeNull();
    // Delivery answers: the first load brings the release's settings.
    api.fail(false);
    await api.publish(await withSettings("Published", "https://published.example/events"));
    expect(await titleOf(cms.forRelease())).toBe("Published");
    expect((await cms.settings()).analytics.collector).toBe("https://published.example/events");
  });

  it("S-2: a newer release's settings arrive with the background check, never before", async () => {
    const api = await deliveryApi();
    await api.publish(await withSettings("First", "https://first.example/events"));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await titleOf(cms.forRelease())).toBe("First");
    const next = await withSettings("Published", "https://next.example/e");
    api.previewHosts(["www.example.com"]);
    await api.publish(next);
    const before = await cms.settings();
    expect(before.analytics.collector).toBe("https://first.example/events");
    expect(await cms.update()).toEqual({ updated: true });
    const after = await cms.settings();
    expect(after.analytics.collector).toBe("https://next.example/e");
    expect(after.preview.hosts).toEqual(["www.example.com"]);
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
    const api = await deliveryApi();
    const cms = createCMS({
      blocks: docsBlocks(),
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

  it("HRI-6: indexes are ordered by sequence, never by id or date: a higher sequence is followed, a lower one never", async () => {
    const api = await deliveryApi();
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    const five = await hashed("Five");
    const four = await hashed("Four");
    await api.publish(five, { sequence: 5 });
    await cms.update();
    expect(await titleOf(cms.forRelease())).toBe("Five");
    // An id and a date that look older, under a higher sequence: followed.
    await api.publish(four, { sequence: 6 });
    api.patchLatest({ publishedAt: "1970-01-01T00:00:00Z" });
    expect(await cms.update()).toEqual({ updated: true });
    expect(await cms.forRelease().revision()).toBe(four.revision);
    // Five again under its own sequence (a stale CDN copy): never.
    await api.publish(five, { sequence: 5 });
    expect(await cms.update()).toEqual({ updated: false });
    expect(await cms.forRelease().revision()).toBe(four.revision);
    const sdk = fs.readFileSync(path.join(HERE, "../remoteLoader.ts"), "utf8");
    expect(sdk).not.toMatch(/generation|channels/);
  });

  it("HRI-8: a body is never compared with its hash: what blocks/<hash>.json holds is what is served", async () => {
    const api = await deliveryApi();
    const real = await hashed("Real");
    await api.publish(real);
    api.asset(api.blockPath("SummerSEO"), seoEntry("Rewritten"));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await titleOf(cms.forRelease())).toBe("Rewritten");
    const sdk = fs.readFileSync(path.join(HERE, "../remoteLoader.ts"), "utf8");
    expect(sdk).not.toMatch(/computeContentRevision|sha256/);
  });

  it("HRI-10/HD-4: a draft that can't be fetched is LOADER_FAILED on every call; published content is never substituted", async () => {
    const api = await deliveryApi();
    await api.publish(await hashed("Release"));
    const cms = createCMS({
      blocks: docsBlocks(),
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
    const config = { blocks: docsBlocks(), site: SITE, token: TOKEN };
    const a = createCMS(config);
    const b = createCMS({ ...config });
    expect(instanceOf(b)).toBe(instanceOf(a));
    const keys = Object.getOwnPropertySymbols(globalThis)
      .map((s) => Symbol.keyFor(s))
      .filter((k): k is string => typeof k === "string" && k.startsWith("decocms.blocks"));
    expect(keys.some((k) => k.startsWith("decocms.blocks.cms:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("decocms.blocks.remote:"))).toBe(true);
    expect(keys.join("\n")).not.toContain(TOKEN);
  });

  it("HRI-12: with a site the key is the site, never the token; without, the content identity, never the revision", async () => {
    const blocks = docsBlocks();
    const a = createCMS({ blocks, site: SITE, token: "t1" });
    expect(createCMS({ blocks, site: SITE })).toBe(a);
    expect(createCMS({ blocks, site: "other" })).not.toBe(a);
    const local = createCMS({ blocks, content: { ...docsSnapshot("rev-1"), root: ".deco" } });
    expect(local).not.toBe(a);
    const reloaded = createCMS({ blocks, content: { ...docsSnapshot("rev-2"), root: ".deco" } });
    expect(reloaded).toBe(local);
    expect(await reloaded.forRelease().revision()).toBe("rev-2");
    const otherFolder = createCMS({
      blocks,
      content: { ...docsSnapshot("rev-2"), root: "apps/b/.deco" },
    });
    expect(otherFolder).not.toBe(local);
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
    const a = createCMS({ blocks: docsBlocks(), site: SITE });
    const loaderA = remote();
    resetForTests();
    expect(createCMS({ blocks: docsBlocks(), site: SITE })).not.toBe(a);
    expect(remote()).not.toBe(loaderA);
    expect(typeof (root as Record<string, unknown>).resetForTests).toBe("function");
  });

  it("HRI-16: the SDK reads no git API and no environment; no bundle is compared with a release", () => {
    for (const file of ["../remoteLoader.ts", "../cms.ts", "../content.ts"]) {
      const sdk = fs.readFileSync(path.join(HERE, file), "utf8");
      expect(sdk, file).not.toMatch(/github|rev-parse|GIT_[A-Z]|committedAt|schemaHash/i);
      expect(
        [...sdk.matchAll(/^(?!\s*\*).*process\.env\.([A-Z_]+)/gm)].map((m) => m[1]),
        file,
      ).toEqual([]);
    }
  });
});
