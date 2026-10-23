// @vitest-environment node
/**
 * The worker entry's page cache and purge (the one copy of the recipe
 * @decocms/tanstack's README links to): the real `createDecoWorker` and the
 * recipe, with the Cache API, the content and TanStack Start's server entry replaced
 * by test doubles.
 */
import { createCMS, type Snapshot } from "@decocms/blocks";
import {
  assign,
  newVisitor,
  parseVisitor,
  serializeVisitor,
  type Visitor,
} from "@decocms/blocks/experiments";
import { DRAFT_COOKIE, DRAFT_PARAM } from "@decocms/tanstack";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__BUILD_HASH__ = "b1";
  const state: {
    cms: unknown;
    served: Request[];
    respond: (request: Request) => Response | Promise<Response>;
  } = {
    cms: undefined,
    served: [],
    respond: () => new Response(),
  };
  return state;
});

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: {
    fetch: (request: Request) => {
      doubles.served.push(request);
      return doubles.respond(request);
    },
  },
  createServerEntry: (entry: unknown) => entry,
}));
// The recipe imports `cms` once; each test points it at its own content.
vi.mock("./cms", () => ({
  cms: new Proxy(
    {},
    {
      get: (_target, name) => {
        const cms = doubles.cms as Record<string | symbol, unknown>;
        const value = cms[name];
        return typeof value === "function" ? value.bind(cms) : value;
      },
    },
  ),
}));

class MemoryCache {
  readonly entries = new Map<string, Response>();
  failDeletes = false;
  async match(key: Request) {
    return this.entries.get(key.url)?.clone();
  }
  async put(key: Request, response: Response) {
    this.entries.set(key.url, new Response(await response.arrayBuffer(), response));
  }
  async delete(key: Request) {
    if (this.failDeletes) throw new Error("too many subrequests");
    return this.entries.delete(key.url);
  }
  keys() {
    return [...this.entries.keys()].sort();
  }
}

const ORIGIN = "https://store.example.com";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) Chrome/130";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";
const POINTER = "studio.decocms.com/api/acme/decofile/store/main/changes?token=abc@9f3c1a";
const BF = { start: "2026-11-27T00:00:00Z", end: "2026-12-01T23:59:59Z" };
const TOKEN = "s3cret";

let entry: { fetch(request: Request, env: object, ctx: object): Promise<Response> };
let cache: MemoryCache;
let roots = 0;

beforeAll(async () => {
  vi.stubEnv("DEV", false);
  entry = (await import("./worker-entry")).default;
});
beforeEach(() => {
  cache = new MemoryCache();
  vi.stubGlobal("caches", { default: cache });
  doubles.served = [];
  doubles.respond = (request) =>
    new Response(`<p>${new URL(request.url).pathname}</p>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  content({});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The release the CMS serves: a home page, and the saved `experiments` and `campaigns` when given. */
function content(options: {
  experiments?: Record<string, number>;
  campaigns?: Record<string, { start?: string; end?: string }>;
}) {
  const blocks: Record<string, unknown> = {
    Home: { __resolveType: "page", path: "/", sections: [] },
  };
  if (options.experiments)
    blocks.experiments = { __resolveType: "split-traffic", ...options.experiments };
  if (options.campaigns) blocks.campaigns = { __resolveType: "calendar", ...options.campaigns };
  roots += 1;
  doubles.cms = createCMS({
    blocks: {},
    content: {
      revision: "rev-1",
      blocks,
      root: `/recipe-${roots}`,
      // Studio's release metadata: where the store previews.
      previewHosts: ["store.example.com"],
    } as Snapshot & { root: string },
  });
}

const work: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void work.push(p) };

async function get(
  path: string,
  init: RequestInit & { ua?: string; visitor?: Visitor | null } = {},
) {
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", init.ua ?? DESKTOP);
  // A returning visitor unless the test passes `visitor: null` (a first visit).
  const visitor = init.visitor === undefined ? newVisitor() : init.visitor;
  if (visitor) headers.append("cookie", `deco_segment=${serializeVisitor(visitor)}`);
  const response = await entry.fetch(
    new Request(`${ORIGIN}${path}`, { ...init, headers }),
    { PURGE_TOKEN: TOKEN },
    ctx,
  );
  while (work.length) await Promise.allSettled(work.splice(0));
  return response;
}

function purge(body: unknown, token = TOKEN) {
  return get("/_cache/purge", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Two visitors on opposite sides of a 50% `hero` test. */
function visitorsAcross(): { inside: Visitor; outside: Visitor } {
  let inside: Visitor | undefined;
  let outside: Visitor | undefined;
  while (!inside || !outside) {
    const v = newVisitor();
    if (assign({ hero: 50 }, v).hero) inside ??= v;
    else outside ??= v;
  }
  return { inside, outside };
}

const KEY = `${ORIGIN}/?__v=b1.rev-1&__seg=device%3Ddesktop`;

describe("the page cache", () => {
  it("a page is a MISS, then a HIT, keyed on path, version and segment", async () => {
    const first = await get("/");
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(first.headers.get("x-cache-version")).toBe("b1.rev-1");
    const second = await get("/");
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(await second.text()).toBe("<p>/</p>");
    expect(doubles.served).toHaveLength(1);
    expect(cache.keys()).toEqual([KEY]);
  });

  it("devices get their own entries; tracking params share one", async () => {
    await get("/shoes?utm_source=x");
    await get("/shoes", { ua: PHONE });
    expect((await get("/shoes?gclid=1")).headers.get("x-cache")).toBe("HIT");
    expect(cache.keys()).toEqual([
      `${ORIGIN}/shoes?__v=b1.rev-1&__seg=device%3Ddesktop`,
      `${ORIGIN}/shoes?__v=b1.rev-1&__seg=device%3Dmobile`,
    ]);
  });

  it("previews never reach the cache: a draft renders, uncached, and stores nothing", async () => {
    await get("/");
    // The drafts' host answers the pointer's (empty) changes: the worker reads the draft first.
    vi.stubGlobal("fetch", async () => Response.json({ set: {}, delete: [] }));
    const draft = await get(`/?${DRAFT_PARAM}=${encodeURIComponent(POINTER)}`);
    expect(draft.headers.get("set-cookie")).toContain(`${DRAFT_COOKIE}=studio`);
    expect(draft.headers.get("cache-control")).toBe("max-age=0, no-cache, must-revalidate");
    expect(draft.headers.has("x-cache")).toBe(false);
    expect(doubles.served).toHaveLength(2);
    expect(cache.keys()).toEqual([KEY]);
  });

  it("a private profile, and a response that says private or sets a cookie, are never stored", async () => {
    expect((await get("/account")).headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
    doubles.respond = () => new Response("x", { headers: { "set-cookie": "session=1; Path=/" } });
    expect((await get("/shoes")).headers.get("x-cache-reason")).toBe("private-response");
    expect(cache.keys()).toEqual([]);
  });

  it("a degraded page is never stored", async () => {
    doubles.respond = () => new Response("x", { headers: { "x-deco-degraded": "true" } });
    expect((await get("/shoes")).headers.get("x-cache-reason")).toBe("degraded");
    expect(cache.keys()).toEqual([]);
  });
});

describe("the key carries the request's assignments", () => {
  const as = (visitor: Visitor) => ({ visitor });

  it("visitors on opposite sides of a test get their own entries; the same side shares one", async () => {
    content({ experiments: { hero: 50 } });
    const { inside, outside } = visitorsAcross();
    let another = newVisitor();
    while (!assign({ hero: 50 }, another).hero) another = newVisitor();
    expect((await get("/", as(inside))).headers.get("x-cache")).toBe("MISS");
    expect((await get("/", as(outside))).headers.get("x-cache")).toBe("MISS");
    expect((await get("/", as(another))).headers.get("x-cache")).toBe("HIT");
    expect(doubles.served).toHaveLength(2);
    expect(cache.keys()).toEqual([KEY, `${KEY}&__a=x%3Dhero`]);
  });

  it("the visitor id is never in the key", async () => {
    content({ experiments: { hero: 50 } });
    const { inside, outside } = visitorsAcross();
    await get("/", as(inside));
    await get("/", as(outside));
    for (const key of cache.keys()) {
      expect(key).not.toContain(inside.id);
      expect(key).not.toContain(outside.id);
    }
  });

  it("a campaign starting changes the key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(BF.start) - 60_000);
    content({ campaigns: { "black-friday": BF } });
    expect((await get("/")).headers.get("x-cache")).toBe("MISS");
    expect((await get("/")).headers.get("x-cache")).toBe("HIT");
    vi.setSystemTime(Date.parse(BF.start) + 1_000);
    expect((await get("/")).headers.get("x-cache")).toBe("MISS");
    expect(cache.keys().at(-1)).toBe(`${KEY}&__a=c%3Dblack-friday`);
  });

  it("a first visit is keyed on its new visitor's side, and a HIT still sets that visitor's cookie", async () => {
    content({ experiments: { hero: 50 } });
    const sides = new Set<boolean>();
    for (let i = 0; i < 12; i++) {
      const res = await get("/", { visitor: null });
      const cookies = res.headers.getSetCookie().filter((c) => c.startsWith("deco_segment="));
      expect(cookies).toHaveLength(1);
      const visitor = parseVisitor(
        (cookies[0] as string).split(";")[0]?.slice("deco_segment=".length) ?? null,
      );
      expect(visitor).not.toBe(null);
      const side = assign({ hero: 50 }, visitor).hero === true;
      expect(res.headers.get("x-cache")).toBe(sides.has(side) ? "HIT" : "MISS");
      sides.add(side);
    }
    expect(doubles.served).toHaveLength(sides.size);
    for (const stored of cache.entries.values())
      expect(stored.headers.has("set-cookie")).toBe(false);
  });

  it("the document's CDN token follows the assignments, and only navigation data with it may be kept by the CDN", async () => {
    content({ experiments: { hero: 50 } });
    const { inside, outside } = visitorsAcross();
    const tokens: (string | null)[] = [];
    doubles.respond = () => new Response("{}", { headers: { "content-type": "application/json" } });
    const payload = encodeURIComponent(JSON.stringify({ data: { href: "/shoes" } }));
    const { segmentToken } = await import("@decocms/tanstack/worker");
    for (const v of [inside, outside]) {
      const assigned = assign({ hero: 50 }, v).hero ? "b1.rev-1|x=hero" : "b1.rev-1";
      tokens.push(segmentToken({ device: "desktop" }, assigned));
    }
    expect(tokens[0]).not.toBe(tokens[1]);
    const kept = await get(`/_serverFn/abc?payload=${payload}&__cseg=${tokens[0]}`, as(inside));
    expect(kept.headers.get("cdn-cache-control")).toBe("public, max-age=120");
    const forged = await get(`/_serverFn/abc?payload=${payload}&__cseg=${tokens[1]}`, as(inside));
    expect(forged.headers.get("cdn-cache-control")).toBe("no-store");
    const page = await get("/shoes", as(inside));
    expect(page.headers.get("cdn-cache-control")).toBe("no-store");
  });
});

describe("purge", () => {
  it("v7's request: a Bearer token and { paths }; v7's answer; every stored copy of the path dropped", async () => {
    await get("/shoes");
    await get("/shoes", { ua: PHONE });
    await get("/shoes", { headers: { "sec-fetch-dest": "empty" } });
    await get("/other");
    const res = await purge({ paths: ["/shoes"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      purged: [
        "/shoes (device=mobile)",
        "/shoes (device=desktop)",
        "/shoes (device=desktop, fetch)",
      ],
      total: 3,
    });
    expect(cache.keys()).toEqual([`${ORIGIN}/other?__v=b1.rev-1&__seg=device%3Ddesktop`]);
  });

  it("the purge's keys are the stored keys byte for byte: tracking params, __cseg and variant params dropped", async () => {
    await get("/shoes?utm_source=x&__cseg=deadbeef");
    expect(cache.keys()).toEqual([`${ORIGIN}/shoes?__v=b1.rev-1&__seg=device%3Ddesktop`]);
    await purge({ paths: ["/shoes"] });
    expect(cache.keys()).toEqual([]);
  });

  it("exact paths only, as v7: /shoes never drops /shoes?page=2", async () => {
    await get("/shoes?page=2");
    await purge({ paths: ["/shoes"] });
    expect(cache.keys()).toHaveLength(1);
    await purge({ paths: ["/shoes?page=2"] });
    expect(cache.keys()).toEqual([]);
  });

  for (const running of [1, 2, 3]) {
    it(`with ${running} tests at 50% (and tests at 0 and 100), every assignments subset is dropped`, async () => {
      const tests = Object.fromEntries(Array.from({ length: running }, (_, i) => [`t${i}`, 50]));
      content({ experiments: { ...tests, off: 0, all: 100 } });
      for (let i = 0; i < 40; i++) await get("/");
      const stored = cache.keys().length;
      expect(stored).toBeGreaterThan(1);
      const res = await purge({ paths: ["/"] });
      expect((await res.json()).total).toBe(stored);
      expect(cache.keys()).toEqual([]);
    });
  }

  it("the campaigns running now and none: copies from before a campaign started are dropped too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(BF.start) - 60_000);
    content({ campaigns: { "black-friday": BF } });
    await get("/");
    vi.setSystemTime(Date.parse(BF.start) + 1_000);
    await get("/");
    expect(cache.keys()).toHaveLength(2);
    await purge({ paths: ["/"] });
    expect(cache.keys()).toEqual([]);
  });

  it("segments in the body replace the devices: the site's own parts", async () => {
    await get("/shoes");
    const res = await purge({ paths: ["/shoes"], segments: [{ device: "mobile" }] });
    expect((await res.json()).total).toBe(0);
    await purge({ paths: ["/shoes"], segments: [{ device: "desktop" }] });
    expect(cache.keys()).toEqual([]);
  });

  it("a wrong or missing token is a 401; a body that isn't JSON, or has no paths, a 400", async () => {
    expect((await purge({ paths: ["/"] }, "wrong")).status).toBe(401);
    expect((await get("/_cache/purge", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await purge("not json")).status).toBe(400);
    expect((await purge({ paths: [] })).status).toBe(400);
  });

  it("without the Cache API, v7's note", async () => {
    vi.stubGlobal("caches", undefined);
    expect(await (await purge({ paths: ["/"] })).json()).toEqual({
      purged: [],
      total: 0,
      note: "Cache storage unavailable",
    });
  });

  it("a failed delete is a 503 naming the paths to send again", async () => {
    cache.failDeletes = true;
    const res = await purge({ paths: ["/a", "/b"] });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ purged: [], notPurged: ["/a", "/b"], total: 0 });
  });
});
