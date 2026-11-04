// @vitest-environment node
/**
 * remoteLoader (hosted-releases-internals.mdx, hosted-publishing.mdx,
 * content-delivery.mdx): runtime-only content. The first use loads
 * `sites/<site>/latest.json` and the `revisions/<id>/data.json` it names,
 * once however many ask; the background check follows `latest.json`. Drafts
 * aren't the loader's (see draftChanges.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCMS, resetForTests } from "./cms";
import { READ_REVISION } from "./content";
import { ContentUnavailableError } from "./errors";
import { remoteLoader } from "./remoteLoader";
import { docsBlocks, docsSnapshot } from "./testFixtures";
import type { CMSError, Loader, Snapshot } from "./types";

const ORIGIN = "https://delivery.decocms.com";
const SITE = "acme";
const LATEST_URL = `${ORIGIN}/sites/acme/latest.json`;
/** A revision id (`<inv>-<uuidv7>`), distinct per digit. */
const rid = (n: number) => `fe6c5e0d97f${n}-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a5${n}`;
const REV_1 = rid(1);
const REV_2 = rid(2);
const dataUrl = (id: string) => `${ORIGIN}/sites/acme/revisions/${id}/data.json`;

beforeEach(() => resetForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** What Studio writes for a publish: the blocks of that revision. */
function blocksAt(title: string): Record<string, unknown> {
  return { SummerSEO: { __resolveType: "seo", title, description: "d" } };
}

/** A fake delivery CDN: `latest.json` and immutable `revisions/<id>/data.json`. */
function delivery() {
  const objects = new Map<string, unknown>();
  const gates = new Map<string, Promise<void>>();
  const requests: { url: string; headers: Record<string, string>; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), init });
    const key = url.slice(ORIGIN.length);
    const gate = gates.get(key);
    if (gate) {
      // A fetch that waits ends when its signal does, as a real one.
      const signal = init?.signal;
      await Promise.race([
        gate,
        new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    }
    if (!objects.has(key)) return new Response("not found", { status: 404 });
    const body = objects.get(key);
    return body instanceof Response ? body : Response.json(body);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    requests,
    urls: () => requests.map((r) => r.url),
    /** Studio's publish: the revision, then the pointer. */
    publish(id: string, title: string) {
      objects.set(`/sites/acme/revisions/${id}/data.json`, { blocks: blocksAt(title) });
      objects.set("/sites/acme/latest.json", { revision: id, previewHosts: ["*.example.com"] });
    },
    /** Studio's rollback writes a new revision; this rewrites the pointer only (any revision). */
    point(value: unknown) {
      objects.set("/sites/acme/latest.json", value);
    },
    put(key: string, value: unknown) {
      objects.set(key, value);
    },
    remove(key: string) {
      objects.delete(key);
    },
    /** Holds every fetch of `key` until released (or its signal aborts). */
    hold(key: string) {
      let release!: () => void;
      gates.set(
        key,
        new Promise<void>((r) => {
          release = r;
        }),
      );
      return () => {
        gates.delete(key);
        release();
      };
    },
  };
}

/** The `ContentUnavailableError` a load rejected with, directly or as a `LOADER_FAILED` cause. */
async function unavailable(promise: Promise<unknown>): Promise<ContentUnavailableError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  const cause = error instanceof ContentUnavailableError ? error : (error as CMSError).cause;
  expect(cause).toBeInstanceOf(ContentUnavailableError);
  return cause as ContentUnavailableError;
}

/** Makes the next `AbortSignal.timeout(ms)` fire at once, as 10 s with no answer would. */
function timeOutFetches() {
  const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    queueMicrotask(() =>
      controller.abort(new DOMException(`timed out after ${ms} ms`, "TimeoutError")),
    );
    return controller.signal;
  });
  return spy;
}

describe("remoteLoader: the first load", () => {
  it("reads latest.json, then revisions/<id>/data.json, with no credentials and a 10 s signal", async () => {
    const api = delivery();
    api.publish(REV_1, "Published");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const loader = remoteLoader(undefined, { site: SITE });

    expect(await loader.load()).toEqual({ revision: REV_1, blocks: blocksAt("Published") });
    expect(api.urls()).toEqual([LATEST_URL, dataUrl(REV_1)]);
    expect(api.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
    expect(api.requests.every((r) => r.init?.credentials === undefined)).toBe(true);
    expect(timeout.mock.calls).toEqual([[10_000], [10_000]]);
    expect(api.requests.every((r) => r.init?.signal instanceof AbortSignal)).toBe(true);
    // Held: the next load touches nothing.
    await loader.load();
    expect(api.fetch).toHaveBeenCalledTimes(2);
  });

  it("30 concurrent loads of a cold loader share one fetch of each object", async () => {
    const api = delivery();
    api.publish(REV_1, "Published");
    const release = api.hold("/sites/acme/latest.json");
    const loader = remoteLoader(undefined, { site: SITE });
    const loads = Array.from({ length: 30 }, () => loader.load());
    release();
    const snapshots = await Promise.all(loads);
    expect(new Set(snapshots).size).toBe(1);
    expect(api.urls()).toEqual([LATEST_URL, dataUrl(REV_1)]);
  });

  it("30 concurrent resolves on a cold CMS make one fetch of each, the background check included", async () => {
    const api = delivery();
    api.publish(REV_1, "Published");
    // The CDN answers after the background check has started, as a real one does.
    const release = api.hold("/sites/acme/latest.json");
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(api.fetch).not.toHaveBeenCalled(); // nothing at construction
    const pending = Promise.all(
      Array.from({ length: 30 }, () =>
        cms.forRelease().resolve<{ title: string }>("SummerSEO", { run: false }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    const results = await pending;
    expect(results.every(([entry]) => entry?.title === "Published")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.urls()).toEqual([LATEST_URL, dataUrl(REV_1)]);
  });

  it("a timeout aborts and rejects with ContentUnavailableError { reason: 'timeout' }", async () => {
    const api = delivery();
    api.publish(REV_1, "Published");
    api.hold("/sites/acme/latest.json");
    timeOutFetches();
    const loader = remoteLoader(undefined, { site: SITE });
    const error = await unavailable(loader.load());
    expect(error.reason).toBe("timeout");
    expect(error.name).toBe("ContentUnavailableError");
    const signal = api.requests[0]?.init?.signal;
    expect(signal?.aborted).toBe(true);
  });

  it("a timeout while the body downloads is a timeout too", async () => {
    const api = delivery();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 20);
      return controller.signal;
    });
    // latest.json answers; data.json sends headers, then a body that stalls until the signal fires.
    api.fetch.mockImplementationOnce(async () => Response.json({ revision: REV_1 }));
    api.fetch.mockImplementationOnce(async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body);
    });
    const error = await unavailable(remoteLoader(undefined, { site: SITE }).load());
    expect(error.reason).toBe("timeout");
  });

  it("a refused connection is 'network'; an HTTP error is 'http' with its status", async () => {
    const api = delivery();
    const loader = remoteLoader(undefined, { site: SITE });
    api.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await unavailable(loader.load())).reason).toBe("network");

    api.fetch.mockResolvedValueOnce(new Response("down", { status: 503 }));
    const http = await unavailable(loader.load());
    expect([http.reason, http.status]).toEqual(["http", 503]);
  });

  it("a site with nothing published (latest.json 404) is the same error, never an empty release", async () => {
    delivery();
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    const [entry, error] = await cms.forRelease().resolve("SummerSEO");
    expect(entry).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
    const cause = error?.cause as ContentUnavailableError;
    expect(cause).toBeInstanceOf(ContentUnavailableError);
    expect([cause.reason, cause.status]).toEqual(["http", 404]);
    // revision() rejects with that LOADER_FAILED error.
    const rejected = await unavailable(cms.forRelease().revision());
    expect(rejected.status).toBe(404);
  });

  it("a revision latest.json names that isn't there is 'http' 404", async () => {
    const api = delivery();
    api.point({ revision: REV_1 });
    const error = await unavailable(remoteLoader(undefined, { site: SITE }).load());
    expect([error.reason, error.status]).toEqual(["http", 404]);
    expect(api.urls()).toEqual([LATEST_URL, dataUrl(REV_1)]);
  });

  it("a failed load isn't kept: the next call tries again", async () => {
    const api = delivery();
    const loader = remoteLoader(undefined, { site: SITE });
    await unavailable(loader.load());
    api.publish(REV_1, "Published");
    expect((await loader.load()).revision).toBe(REV_1);
  });

  it("refuses a latest.json that doesn't name a revision id: 'format', nothing else downloaded", async () => {
    const api = delivery();
    const loader = remoteLoader(undefined, { site: SITE });
    for (const pointer of [
      null,
      [],
      {},
      { revision: "1".repeat(40) }, // a git commit SHA: the old format
      { revision: "f".repeat(64) },
      { revision: "../../other/revisions/x" },
      { revision: `${REV_1}/../x` },
      { revision: REV_1.toUpperCase() },
      { revision: 1 },
    ]) {
      api.point(pointer);
      expect((await unavailable(loader.load())).reason).toBe("format");
    }
    api.put("/sites/acme/latest.json", new Response("{not json", { status: 200 }));
    expect((await unavailable(loader.load())).reason).toBe("format");
    expect(api.urls().every((url) => url === LATEST_URL)).toBe(true);
  });

  it("refuses a data.json that isn't { blocks }: 'format'", async () => {
    const api = delivery();
    api.point({ revision: REV_1 });
    const loader = remoteLoader(undefined, { site: SITE });
    for (const body of [null, [], {}, { blocks: [] }, { blocks: "x" }]) {
      api.put(`/sites/acme/revisions/${REV_1}/data.json`, body);
      expect((await unavailable(loader.load())).reason).toBe("format");
    }
  });

  it("ignores unknown keys in latest.json and data.json: no schemaHash, date or body check", async () => {
    const api = delivery();
    api.point({
      revision: REV_1,
      schemaHash: "a".repeat(64),
      publishedAt: "not a date",
      previewHosts: [],
      future: true,
    });
    api.put(`/sites/acme/revisions/${REV_1}/data.json`, {
      blocks: blocksAt("Published"),
      revision: REV_2, // never compared with the id in the path
      schemaHash: "b".repeat(64),
    });
    const loader = remoteLoader(undefined, { site: SITE });
    expect(await loader.load()).toEqual({ revision: REV_1, blocks: blocksAt("Published") });
  });

  it("refuses a revision larger than 64 MiB while it downloads", async () => {
    const api = delivery();
    api.point({ revision: REV_1 });
    api.put(
      `/sites/acme/revisions/${REV_1}/data.json`,
      new Response("{}", { headers: { "content-length": String(64 * 1024 * 1024 + 1) } }),
    );
    const error = await unavailable(remoteLoader(undefined, { site: SITE }).load());
    expect(error.reason).toBe("format");
    expect(error.message).toMatch(/larger than/);
  });

  it("reads no environment: NODE_ENV=development loads and swaps like production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const api = delivery();
    api.publish(REV_1, "One");
    const loader = remoteLoader(undefined, { site: SITE });
    expect((await loader.load()).revision).toBe(REV_1);
    api.publish(REV_2, "Two");
    expect(await loader.update?.()).toEqual({ updated: true });
  });
});

describe("remoteLoader: update()", () => {
  it("before the first load, the check is that load (shared), and reports no swap", async () => {
    const api = delivery();
    api.publish(REV_1, "Published");
    const loader = remoteLoader(undefined, { site: SITE });
    const [check, load] = await Promise.all([loader.update?.(), loader.load()]);
    expect(check).toEqual({ updated: false });
    expect(load.revision).toBe(REV_1);
    expect(api.urls()).toEqual([LATEST_URL, dataUrl(REV_1)]);
  });

  it("swaps when latest.json names another revision, after it is downloaded and parsed", async () => {
    const api = delivery();
    api.publish(REV_1, "One");
    const loader = remoteLoader(undefined, { site: SITE });
    await loader.load();
    api.publish(REV_2, "Two");
    const release = api.hold(`/sites/acme/revisions/${REV_2}/data.json`);
    const check = loader.update?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The old release keeps serving while the new one downloads.
    expect((await loader.load()).revision).toBe(REV_1);
    release();
    expect(await check).toEqual({ updated: true });
    expect(await loader.load()).toEqual({ revision: REV_2, blocks: blocksAt("Two") });
  });

  it("the same revision downloads nothing", async () => {
    const api = delivery();
    api.publish(REV_1, "Published");
    const loader = remoteLoader(undefined, { site: SITE });
    await loader.load();
    expect(await loader.update?.()).toEqual({ updated: false });
    expect(api.urls()).toEqual([LATEST_URL, dataUrl(REV_1), LATEST_URL]);
  });

  it("follows whatever latest.json names, an older revision included, with no ordering", async () => {
    const api = delivery();
    api.publish(REV_1, "One");
    api.publish(REV_2, "Two");
    const loader = remoteLoader(undefined, { site: SITE });
    expect((await loader.load()).revision).toBe(REV_2);
    api.point({ revision: REV_1 });
    expect(await loader.update?.()).toEqual({ updated: true });
    expect(await loader.load()).toEqual({ revision: REV_1, blocks: blocksAt("One") });
  });

  it("404, 5xx, network errors, timeouts and bad bodies keep memory; the next check retries", async () => {
    const api = delivery();
    api.publish(REV_1, "One");
    const loader = remoteLoader(undefined, { site: SITE });
    const held = await loader.load();

    api.fetch.mockResolvedValueOnce(new Response("down", { status: 500 }));
    expect((await unavailable(loader.update?.() as Promise<unknown>)).status).toBe(500);
    api.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await unavailable(loader.update?.() as Promise<unknown>)).reason).toBe("network");
    api.remove("/sites/acme/latest.json");
    expect((await unavailable(loader.update?.() as Promise<unknown>)).status).toBe(404);
    api.point({ revision: REV_2 }); // names a revision that isn't there
    expect((await unavailable(loader.update?.() as Promise<unknown>)).status).toBe(404);
    api.put(`/sites/acme/revisions/${REV_2}/data.json`, { blocks: [] });
    expect((await unavailable(loader.update?.() as Promise<unknown>)).reason).toBe("format");
    expect(await loader.load()).toBe(held);

    api.publish(REV_2, "Two");
    expect(await loader.update?.()).toEqual({ updated: true });
    expect((await loader.load()).revision).toBe(REV_2);
  });

  it("with createCMS: a check swaps the release in for the next client; a client keeps its own", async () => {
    const api = delivery();
    api.publish(REV_1, "One");
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    const before = cms.forRelease();
    expect(await before.revision()).toBe(REV_1);
    api.publish(REV_2, "Two");
    expect(await cms.update()).toEqual({ updated: true });
    expect(await before.revision()).toBe(REV_1);
    const client = cms.forRelease();
    expect(await client.revision()).toBe(REV_2);
    const [seo] = await client.resolve<{ title: string }>("SummerSEO");
    expect(seo?.title).toBe("Two");
  });

  it("a CMS that loaded keeps serving its release while the CDN is down", async () => {
    const api = delivery();
    api.publish(REV_1, "One");
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await cms.forRelease().revision()).toBe(REV_1);
    api.fetch.mockRejectedValue(new TypeError("fetch failed"));
    expect(await cms.update()).toEqual({ updated: false });
    const [seo, error] = await cms.forRelease().resolve<{ title: string }>("SummerSEO");
    expect(error).toBeNull();
    expect(seo?.title).toBe("One");
  });
});

describe("remoteLoader: a release by its revision id", () => {
  const read = (loader: Loader, id: string) =>
    (loader as unknown as { [READ_REVISION]: (id: string) => Promise<Snapshot> })[READ_REVISION](
      id,
    );

  it("reads revisions/<id>/data.json once and keeps the last 3 read", async () => {
    const api = delivery();
    for (const n of [1, 2, 3, 4]) {
      api.put(`/sites/acme/revisions/${rid(n)}/data.json`, { blocks: blocksAt(`R${n}`) });
    }
    const loader = remoteLoader(undefined, { site: SITE });
    expect(await read(loader, rid(1))).toEqual({ revision: rid(1), blocks: blocksAt("R1") });
    await read(loader, rid(1));
    expect(api.urls()).toEqual([dataUrl(rid(1))]); // no latest.json, no second read
    for (const n of [2, 3, 4]) await read(loader, rid(n));
    await read(loader, rid(1)); // dropped: the least recently used
    expect(api.urls().filter((url) => url === dataUrl(rid(1)))).toHaveLength(2);
  });

  it("cms.client({ version: <id> }) reads it, with no schema check", async () => {
    const api = delivery();
    api.publish(REV_2, "Latest");
    api.put(`/sites/acme/revisions/${REV_1}/data.json`, { blocks: blocksAt("Older") });
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    const client = cms.client({ version: REV_1 });
    const [seo] = await client.resolve<{ title: string }>("SummerSEO");
    expect(seo?.title).toBe("Older");
    expect(client.version).toBe(REV_1);
  });

  it("a revision that can't be read is LOADER_FAILED with the cause; a malformed id is refused", async () => {
    delivery();
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    const [, error] = await cms.client({ version: REV_1 }).resolve("SummerSEO");
    expect(error?.code).toBe("LOADER_FAILED");
    expect((error as CMSError).cause).toMatchObject({ reason: "http", status: 404 });
    const loader = remoteLoader(undefined, { site: SITE });
    await expect(read(loader, "1".repeat(40))).rejects.toMatchObject({ code: "LOADER_FAILED" });
  });
});

describe("remoteLoader: configuration", () => {
  it("with site, content is never bundled: passing content is a TypeError", () => {
    const api = delivery();
    expect(() => remoteLoader(docsSnapshot(), { site: SITE })).toThrow(TypeError);
    expect(() => createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: SITE })).toThrow(
      "createCMS: with site, content comes from the delivery CDN at runtime; remove content",
    );
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("without site, content is required; createCMS without either is a TypeError", () => {
    expect(() => remoteLoader(undefined, {})).toThrow(TypeError);
    expect(() => createCMS({ blocks: docsBlocks() })).toThrow(TypeError);
  });

  it("a token without site is a configuration error, before anything is fetched", async () => {
    const api = delivery();
    expect(() =>
      createCMS({ blocks: docsBlocks(), content: docsSnapshot(), token: "t", telemetry: false }),
    ).toThrow("token needs site: pass both, or site alone");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("is one instance per process and site; another interval warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = remoteLoader(undefined, { site: SITE });
    expect(remoteLoader(undefined, { site: SITE })).toBe(first);
    expect(remoteLoader(undefined, { site: SITE, interval: 120_000 })).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("interval"));
    expect(remoteLoader(undefined, { site: "other" })).not.toBe(first);
  });

  it("createCMS paces a remoteLoader by its own interval when it has none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    delivery();
    const loader = remoteLoader(undefined, { site: SITE, interval: 300_000 });
    const update = vi.spyOn(loader, "update" as never);
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    cms.forRelease();
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.setSystemTime(new Date("2026-10-03T00:04:00Z"));
    cms.forRelease();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("is a loader over the content alone when site is unset or empty", async () => {
    const content = docsSnapshot();
    for (const loader of [remoteLoader(content, { site: "" }), remoteLoader(content, {})]) {
      expect(await loader.load()).toBe(content);
      expect(loader.update).toBeUndefined();
    }
  });
});
