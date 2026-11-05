// @vitest-environment node
/**
 * remoteLoader (hosted-releases-internals.mdx, content-delivery.mdx; contract
 * §3.1–§3.3, §3.5): runtime-only content on the content-addressed layout. The
 * first use loads `sites/<site>/latest.json`, the index; bodies are fetched by
 * hash when a request needs them; polls revalidate the index with
 * `If-None-Match` and adopt only a higher `sequence`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockStore } from "./blockStore";
import { createCMS, resetForTests } from "./cms";
import { ContentUnavailableError } from "./errors";
import type { HostedSource } from "./hostedSource";
import { remoteLoader } from "./remoteLoader";
import { currentTelemetry } from "./telemetry";
import { docsBlocks, docsSnapshot, fakeDelivery, fakeStudio, revisionId } from "./testFixtures";
import type { CMSError } from "./types";

const SITE = "acme";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The fake CDN, as the global fetch. */
function cdn() {
  const api = fakeDelivery();
  const fetch = vi.fn(api.fetch);
  vi.stubGlobal("fetch", fetch);
  return { ...api, fetch };
}

/** The docs' content with one title changed. */
function content(title = "Sunny!"): Record<string, unknown> {
  const blocks = { ...docsSnapshot().blocks };
  blocks.SummerSEO = { __resolveType: "seo", title, description: "d" };
  return blocks;
}

const hosted = () => remoteLoader(undefined, { site: SITE }) as unknown as HostedSource;

/** Lets background work (polls, warming fetches) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The `ContentUnavailableError` a promise rejected with, directly or as a `LOADER_FAILED` cause. */
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

describe("the index", () => {
  it("a cold load reads latest.json only, with no credentials and a 10 s signal", async () => {
    const api = cdn();
    await api.publish(content());
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const source = hosted();
    const index = await source.current();
    expect(index.revision).toBe(revisionId(1));
    expect(index.sequence).toBe(1);
    expect(api.keys()).toEqual(["latest.json"]);
    expect(api.requests[0]?.headers.authorization).toBeUndefined();
    expect(api.requests[0]?.headers["if-none-match"]).toBeUndefined();
    expect(api.requests[0]?.init?.credentials).toBeUndefined();
    expect(timeout.mock.calls).toEqual([[10_000]]);
    // Held: the next use touches nothing.
    expect(await source.current()).toBe(index);
    expect(api.fetch).toHaveBeenCalledTimes(1);
  });

  it("30 concurrent resolves on a cold CMS: one latest.json and one fetch per hash", async () => {
    const api = cdn();
    await api.publish(content());
    const release = api.hold("latest.json");
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(api.fetch).not.toHaveBeenCalled(); // nothing at construction
    const pending = Promise.all(
      Array.from({ length: 30 }, () => cms.forRelease().resolve<{ name: string }>("HomePage")),
    );
    await settle();
    release();
    const results = await pending;
    expect(results.every(([page]) => page?.name === "Home")).toBe(true);
    await settle();
    // HomePage → SummerCard → CurrentProduct: three bodies, each fetched once.
    expect(api.keys().filter((k) => k === "latest.json")).toHaveLength(1);
    expect(
      api
        .keys()
        .filter((k) => k.startsWith("blocks/"))
        .sort(),
    ).toEqual(
      ["HomePage", "SummerCard", "CurrentProduct"]
        .map((n) => `blocks/${api.hashOf(n)}.json`)
        .sort(),
    );
  });

  it("a timeout, a refused connection and an HTTP error each have their reason", async () => {
    const api = cdn();
    await api.publish(content());
    const source = hosted();
    api.fetch.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    expect((await unavailable(source.current())).reason).toBe("timeout");
    api.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await unavailable(source.current())).reason).toBe("network");
    api.fetch.mockResolvedValueOnce(new Response("down", { status: 503 }));
    const http = await unavailable(source.current());
    expect([http.reason, http.status]).toEqual(["http", 503]);
  });

  it("a cold 404 (nothing published) is ContentUnavailableError, never an empty site", async () => {
    cdn();
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    const [page, error] = await cms.forRelease().resolve("HomePage");
    expect(page).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
    const cause = error?.cause as ContentUnavailableError;
    expect(cause).toBeInstanceOf(ContentUnavailableError);
    expect([cause.reason, cause.status]).toEqual(["http", 404]);
    expect((await unavailable(cms.forRelease().revision())).status).toBe(404);
    const [routes, routesError] = await cms.forRelease().routes();
    expect(routes).toBeNull();
    expect(routesError?.code).toBe("LOADER_FAILED");
  });

  it("a failed load isn't kept: the next call tries again", async () => {
    const api = cdn();
    const source = hosted();
    await unavailable(source.current());
    await api.publish(content());
    expect((await source.current()).revision).toBe(revisionId(1));
  });

  it("refuses an index that isn't one: 'format'", async () => {
    const api = cdn();
    const source = hosted();
    const rev = revisionId(1);
    const hash = "A".repeat(22);
    for (const body of [
      null,
      [],
      { revision: rev, blocks: {} }, // no sequence
      { revision: rev, sequence: 0, blocks: {} },
      { revision: rev, sequence: 1.5, blocks: {} },
      { revision: "1".repeat(40), sequence: 1, blocks: {} },
      { revision: rev, sequence: 1 },
      { revision: rev, sequence: 1, blocks: { Home: {} } },
      { revision: rev, sequence: 1, blocks: { Home: { version: "short" } } },
      { revision: rev, sequence: 1, blocks: { Home: { version: `${hash}/x` } } },
    ]) {
      api.put("latest.json", body);
      expect((await unavailable(source.current())).reason, JSON.stringify(body)).toBe("format");
    }
    api.put("latest.json", new Response("{not json"));
    expect((await unavailable(source.current())).reason).toBe("format");
  });

  it("ignores unknown keys, and keeps data only on the CMS entry", async () => {
    const api = cdn();
    const hash = "A".repeat(22);
    api.put("latest.json", {
      revision: revisionId(1),
      sequence: 1,
      future: true,
      blocks: {
        CMS: { version: hash, data: { __resolveType: "cms-settings" }, extra: 1 },
        Home: { version: hash, data: { leak: true }, meta: { type: "page", path: "/", odd: 1 } },
      },
    });
    const index = await hosted().current();
    expect(index.blocks.CMS).toEqual({ version: hash, data: { __resolveType: "cms-settings" } });
    expect(index.blocks.Home).toEqual({ version: hash, meta: { type: "page", path: "/" } });
  });
});

describe("polls", () => {
  it("send If-None-Match on the held ETag; a 304 parses nothing and keeps the index", async () => {
    const api = cdn();
    await api.publish(content());
    const source = hosted();
    const index = await source.current();
    const json = vi.spyOn(JSON, "parse");
    expect(await source.poll()).toEqual({ updated: false });
    const poll = api.requests[1];
    expect(poll?.key).toBe("latest.json");
    const etag = (await api.fetch.mock.results[0]?.value)?.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(poll?.headers["if-none-match"]).toBe(etag);
    expect((await api.fetch.mock.results[1]?.value)?.status).toBe(304);
    expect(json).not.toHaveBeenCalled();
    expect(source.peek()).toBe(index);
  });

  it("adopts a higher sequence; the index that was current becomes the previous one", async () => {
    const api = cdn();
    await api.publish(content("One"));
    const source = hosted();
    const first = await source.current();
    await api.publish(content("Two"));
    expect(await source.poll()).toEqual({ updated: true });
    expect(source.peek()?.sequence).toBe(2);
    expect(source.previous()).toBe(first);
    // No block was fetched to adopt it: only the index.
    expect(api.blockFetches()).toBe(0);
  });

  it("never adopts a lower or equal sequence (a stale CDN answer never moves it back)", async () => {
    const api = cdn();
    await api.publish(content("One"), { sequence: 5 });
    const source = hosted();
    const held = await source.current();
    await api.publish(content("Older"), { sequence: 4 });
    expect(await source.poll()).toEqual({ updated: false });
    await api.publish(content("Same"), { sequence: 5 });
    expect(await source.poll()).toEqual({ updated: false });
    expect(source.peek()).toBe(held);
    expect(source.previous()).toBeUndefined();
  });

  it("a failed poll keeps the held index, and the next poll retries", async () => {
    const api = cdn();
    await api.publish(content("One"));
    const source = hosted();
    const held = await source.current();
    api.fetch.mockResolvedValueOnce(new Response("down", { status: 500 }));
    await expect(source.poll()).rejects.toBeInstanceOf(ContentUnavailableError);
    api.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(source.poll()).rejects.toBeInstanceOf(ContentUnavailableError);
    api.remove("latest.json");
    await expect(source.poll()).rejects.toBeInstanceOf(ContentUnavailableError);
    expect(source.peek()).toBe(held);
    await api.publish(content("Two"));
    expect(await source.poll()).toEqual({ updated: true });
  });

  it("through createCMS: cms.update() never throws, and a CMS keeps serving while the CDN is down", async () => {
    const api = cdn();
    await api.publish(content("One"));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect((await cms.forRelease().resolve<{ title: string }>("SummerSEO"))[0]?.title).toBe("One");
    api.fetch.mockRejectedValue(new TypeError("fetch failed"));
    expect(await cms.update()).toEqual({ updated: false });
    expect((await cms.forRelease().resolve<{ title: string }>("SummerSEO"))[0]?.title).toBe("One");
  });

  it("a draft request's release check is a poll: it adopts a higher sequence for production", async () => {
    const api = cdn();
    const studio = fakeStudio();
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/drafts/") ? studio.fetch(input, init) : api.fetch(input, init),
    );
    await api.publish(content("One"));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    expect(await cms.forRelease().revision()).toBe(revisionId(1));
    await api.publish(content("Two"));
    const pointer = studio.draft({ set: {} });
    expect(await cms.forDraft(pointer).revision()).toBe(`${revisionId(2)}~9f3c1a`);
    expect(await cms.forRelease().revision()).toBe(revisionId(2));
  });

  it("createCMS paces a remoteLoader by its own interval when it has none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
    cdn();
    const loader = remoteLoader(undefined, { site: SITE, interval: 300_000 });
    const poll = vi.spyOn(loader as unknown as HostedSource, "poll");
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    cms.forRelease();
    await settle();
    vi.setSystemTime(new Date("2026-10-03T00:04:00Z"));
    cms.forRelease();
    await settle();
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe("the block store", () => {
  it("evicts by bytes, least recently used first", async () => {
    const sizes: Record<string, number> = { a: 40, b: 40, c: 40 };
    const fetched: string[] = [];
    const store = new BlockStore(async (hash) => {
      fetched.push(hash);
      return { body: { hash }, bytes: sizes[hash]! };
    }, 100);
    await store.get("a", "A");
    await store.get("b", "B");
    expect(store.peek("a")).toEqual({ hash: "a" }); // a is now the most recent
    await store.get("c", "C"); // 120 bytes > 100: b goes
    expect(store.peek("b")).toBeUndefined();
    expect(store.peek("a")).toBeDefined();
    expect(store.peek("c")).toBeDefined();
    await store.get("b", "B");
    expect(fetched).toEqual(["a", "b", "c", "b"]);
  });

  it("concurrent requests share one fetch per hash", async () => {
    const api = cdn();
    await api.publish(content());
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    await cms.forRelease().revision();
    await Promise.all(
      Array.from({ length: 20 }, () => cms.forRelease().resolve("SummerSEO", { run: false })),
    );
    expect(api.keys().filter((k) => k === `blocks/${api.hashOf("SummerSEO")}.json`)).toHaveLength(
      1,
    );
  });

  it("a failed fetch (a 404 too) isn't cached: the next request fetches again", async () => {
    const api = cdn();
    await api.publish(content());
    const key = `blocks/${api.hashOf("SummerSEO")}.json`;
    api.respond(key, () => new Response("not found", { status: 404 }));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    const [, error] = await cms.forRelease().resolve("SummerSEO");
    expect(error?.code).toBe("LOADER_FAILED");
    expect(error?.cause).toBeInstanceOf(ContentUnavailableError);
    expect((error?.cause as ContentUnavailableError | undefined)?.status).toBe(404);
    expect(error?.message).toContain(api.hashOf("SummerSEO"));
    api.respond(key, null);
    const [seo] = await cms.forRelease().resolve<{ title: string }>("SummerSEO");
    expect(seo?.title).toBe("Sunny!");
    expect(api.keys().filter((k) => k === key)).toHaveLength(2);
  });
});

describe("settings", () => {
  it("cms.settings() reads the inline CMS body: no fetch", async () => {
    const api = cdn();
    await api.publish({
      ...content(),
      CMS: { __resolveType: "cms-settings", analytics: { enabled: false } },
    });
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    await cms.forRelease().revision();
    const before = api.fetch.mock.calls.length;
    const settings = await cms.settings();
    expect(settings.analytics.enabled).toBe(false);
    expect(api.fetch.mock.calls.length).toBe(before);
    expect(api.blockFetches()).toBe(0);
  });

  it("telemetry follows a new index's settings, with no fetch for them", async () => {
    const api = cdn();
    const otlp = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("https://otel.example") ? otlp() : api.fetch(input, init),
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    const settingsWith = (rate: number) => ({
      ...content(),
      CMS: { __resolveType: "cms-settings", telemetry: { traceSampleRate: rate } },
    });
    await api.publish(settingsWith(0));
    const cms = createCMS({
      blocks: docsBlocks(),
      site: SITE,
      telemetry: { endpoint: "https://otel.example", limits: { traceSampleRate: 1 } },
    });
    await cms.forRelease().revision();
    expect(currentTelemetry()?.sampleTrace()).toBe(false);
    await api.publish(settingsWith(1));
    expect(await cms.update()).toEqual({ updated: true });
    await cms.forRelease().revision();
    expect(currentTelemetry()?.sampleTrace()).toBe(true);
    expect(api.blockFetches()).toBe(0);
  });
});

describe("a release by its revision id", () => {
  it("reads revisions/<id>/index.json once, keeps the last 3, bodies by hash", async () => {
    const api = cdn();
    for (const n of [1, 2, 3, 4, 5]) await api.publish(content(`R${n}`));
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    const read = async (n: number) =>
      (await cms.client({ version: revisionId(n) }).resolve<{ title: string }>("SummerSEO"))[0]
        ?.title;
    expect(await read(1)).toBe("R1");
    expect(await read(1)).toBe("R1");
    const indexOf = (n: number) => `revisions/${revisionId(n)}/index.json`;
    expect(api.keys().filter((k) => k === indexOf(1))).toHaveLength(1);
    for (const n of [2, 3, 4]) await read(n);
    expect(await read(1)).toBe("R1"); // dropped: the least recently used
    expect(api.keys().filter((k) => k === indexOf(1))).toHaveLength(2);
    expect(api.keys()).not.toContain("latest.json"); // an explicit version never reads it
  });

  it("cms.client({ version: <id> }) keeps the id as its version", async () => {
    const api = cdn();
    await api.publish(content("Older"));
    await api.publish(content("Latest"));
    const client = createCMS({ blocks: docsBlocks(), site: SITE }).client({
      version: revisionId(1),
    });
    expect((await client.resolve<{ title: string }>("SummerSEO"))[0]?.title).toBe("Older");
    expect(client.version).toBe(revisionId(1));
    expect(await client.revision()).toBe(revisionId(1));
  });

  it("a revision that can't be read is LOADER_FAILED with the cause; a malformed id is refused", async () => {
    cdn();
    const cms = createCMS({ blocks: docsBlocks(), site: SITE });
    const [, error] = await cms.client({ version: revisionId(1) }).resolve("SummerSEO");
    expect(error?.code).toBe("LOADER_FAILED");
    expect((error as CMSError).cause).toMatchObject({ reason: "http", status: 404 });
    await expect(hosted().revision("1".repeat(40))).rejects.toMatchObject({
      code: "LOADER_FAILED",
    });
  });
});

describe("configuration", () => {
  it("with site, content is never bundled: passing content is a TypeError", () => {
    const api = cdn();
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

  it("a hosted loader has no whole snapshot to load", async () => {
    await expect(remoteLoader(undefined, { site: SITE }).load()).rejects.toMatchObject({
      code: "LOADER_FAILED",
    });
  });

  it("is one instance per process and site; another interval warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = remoteLoader(undefined, { site: SITE });
    expect(remoteLoader(undefined, { site: SITE })).toBe(first);
    expect(remoteLoader(undefined, { site: SITE, interval: 120_000 })).toBe(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("interval"));
    expect(remoteLoader(undefined, { site: "other" })).not.toBe(first);
  });

  it("is a loader over the content alone when site is unset or empty", async () => {
    const snapshot = docsSnapshot();
    for (const loader of [remoteLoader(snapshot, { site: "" }), remoteLoader(snapshot, {})]) {
      expect(await loader.load()).toBe(snapshot);
      expect(loader.update).toBeUndefined();
    }
  });
});
