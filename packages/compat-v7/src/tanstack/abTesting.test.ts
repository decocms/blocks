// @vitest-environment node
/**
 * `@decocms/compat-v7/tanstack/worker` against v7's own sdk/abTesting.ts
 * (latest 7.x, `src/__fixtures__/v7`, evaluated unchanged):
 *
 * - 3,000 seeded requests through v7's `withABTesting(worker)` and through
 *   `abTestingRoutes` in a worker's `routes` (the worker calls its routes,
 *   then serves): the same response (status, headers, body), the same calls
 *   to the legacy origin and to the worker, the same errors;
 * - v7's exported helpers on the same inputs;
 * - inside the real `createDecoWorker`: the "worker" bucket's page gets the
 *   bucket cookie once, the worker's own headers once, the page is rendered
 *   once (no loop), and cached pages are tagged too.
 */
import { type CMS, createCMS, type Snapshot } from "@decocms/blocks";
import { newVisitor, serializeVisitor } from "@decocms/blocks/experiments";
import { createDecoWorker } from "@decocms/tanstack/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v7Loader } from "../__tests__/loadV7";
import { pick, rng } from "../__tests__/v7";
import {
  type ABTestConfig,
  abTestingRoutes,
  createReplaceStream,
  getStableBucket,
  type SiteConfig,
  tagBucket,
} from "./abTesting.ts";

const v7 = v7Loader()("sdk/abTesting.ts");

const FUZZ = { timeout: 120_000 };
const HOST = "loja.example";
const LEGACY = "legacy.loja.example";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Generated cases
// ---------------------------------------------------------------------------

/** A body in chunks cut at random byte offsets (multi-byte characters split too). */
function chunked(r: () => number, text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const size = 1 + Math.floor(r() * 12);
    parts.push(bytes.slice(at, at + size));
    at += size;
  }
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

interface Case {
  url: string;
  method: string;
  headers: [string, string][];
  body?: string;
  env: Record<string, unknown>;
  kvValue: unknown;
  config: ABTestConfig;
  /** What the legacy origin answers (or "throw"). */
  legacy:
    | { status: number; type: string; body: string; cookies: string[]; location?: string }
    | "throw";
  /** What the worker answers (or "throw"). */
  worker: { status: number; body: string; cookies: string[] } | "throw";
  /** Whether the worker reads the request body. */
  workerReadsBody: boolean;
  preHandler: "none" | "null" | "response";
  bypass: boolean;
  chunkSeed: number;
  seed: number;
}

function randomCase(r: () => number): Case {
  const cookieName = r() < 0.2 ? "ab" : "_deco_bucket";
  const ratio = pick(r, [
    0,
    0.004,
    0.01,
    0.3,
    0.5,
    0.501,
    0.99,
    0.995,
    1,
    1.2,
    -1,
    Number.NaN,
    undefined,
  ]);
  const cookieValue = pick(r, [
    "worker:50",
    "fallback:50",
    "worker:30",
    "fallback:0",
    "worker:100",
    "fallback:1711540800",
    "worker",
    "nope:50",
    ":50",
    "worker:abc",
    "fallback:101",
  ]);
  const headers: [string, string][] = [];
  if (r() < 0.6) {
    const others = r() < 0.5 ? "a=1; " : "";
    headers.push(["cookie", `${others}${cookieName}=${cookieValue}${r() < 0.3 ? "; b=x=y" : ""}`]);
  }
  if (r() < 0.8)
    headers.push(["cf-connecting-ip", `10.${Math.floor(r() * 256)}.0.${Math.floor(r() * 256)}`]);
  if (r() < 0.3) headers.push(["connection", "keep-alive"]);
  if (r() < 0.3) headers.push(["x-custom", "1"]);
  const query = pick(r, [
    "",
    `?${cookieName}=worker`,
    `?${cookieName}=fallback`,
    "?x=1",
    `?${cookieName}=other`,
  ]);
  const path = pick(r, ["/", "/p/shoe", "/api/cart", "/checkout"]);
  const method = r() < 0.8 ? "GET" : "POST";
  const kvValue = pick<unknown>(r, [
    {
      workerName: "w",
      fallbackOrigin: LEGACY,
      abTest: ratio === undefined ? undefined : { ratio },
    },
    {
      workerName: "w",
      fallbackOrigin: LEGACY,
      abTest: ratio === undefined ? undefined : { ratio },
    },
    {
      workerName: "w",
      fallbackOrigin: LEGACY,
      abTest: ratio === undefined ? undefined : { ratio },
    },
    { workerName: "w", fallbackOrigin: "" },
    null,
  ]);
  const env: Record<string, unknown> =
    r() < 0.1 ? {} : { [r() < 0.2 ? "MY_KV" : "SITES_KV"]: true };
  const config: ABTestConfig = {};
  if (env.MY_KV) config.kvBinding = "MY_KV";
  if (cookieName !== "_deco_bucket") config.cookieName = cookieName;
  if (r() < 0.2) config.cookieMaxAge = 3600;
  if (r() < 0.2) config.circuitBreaker = false;
  const type = pick(r, [
    "text/html; charset=utf-8",
    "application/json",
    "text/javascript",
    "image/png",
  ]);
  return {
    url: `https://${HOST}${path}${query}`,
    method,
    headers,
    body: method === "POST" ? `{"q":"${LEGACY} ç"}` : undefined,
    env,
    kvValue,
    config,
    legacy:
      r() < 0.08
        ? "throw"
        : {
            status: pick(r, [200, 200, 200, 302, 404, 500]),
            type,
            body: `<a href="https://${LEGACY}/x">${LEGACY}</a> ção ${LEGACY}${LEGACY.slice(0, 5)}`,
            cookies:
              r() < 0.5
                ? [`s=1; Domain=${LEGACY}; Path=/`, `t=2; Domain=.${LEGACY.toUpperCase()}`, "u=3"]
                : [],
            location: r() < 0.5 ? `https://${LEGACY}/next` : undefined,
          },
    worker:
      r() < 0.1
        ? "throw"
        : {
            status: pick(r, [200, 200, 404]),
            body: `page ${path}`,
            cookies: r() < 0.3 ? ["vtex_segment=1; Path=/"] : [],
          },
    workerReadsBody: method === "POST" && r() < 0.7,
    preHandler: pick(r, ["none", "none", "none", "null", "response"]),
    bypass: r() < 0.15,
    chunkSeed: Math.floor(r() * 2 ** 31),
    seed: Math.floor(r() * 2 ** 31),
  };
}

interface Outcome {
  response?: { status: number; headers: [string, string][]; body: string };
  error?: string;
  legacyCalls: unknown[];
  workerCalls: unknown[];
  errors: number;
}

async function headersOf(h: Headers): Promise<[string, string][]> {
  return [...h.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Runs one case through `serve` with the legacy origin, KV and worker doubles. */
async function run(
  c: Case,
  serve: (
    request: Request,
    env: Record<string, unknown>,
    worker: { fetch(request: Request): Promise<Response> },
  ) => Promise<Response>,
): Promise<Outcome> {
  const legacyCalls: unknown[] = [];
  const workerCalls: unknown[] = [];
  const r = rng(c.chunkSeed);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    legacyCalls.push({
      url,
      method: init.method,
      redirect: init.redirect,
      headers: await headersOf(new Headers(init.headers)),
      body: init.body ? await new Response(init.body).text() : null,
    });
    if (c.legacy === "throw") throw new Error("legacy down");
    const headers = new Headers({ "content-type": c.legacy.type, "content-length": "999" });
    for (const k of c.legacy.cookies) headers.append("set-cookie", k);
    if (c.legacy.location) headers.set("location", c.legacy.location);
    return new Response(chunked(r, c.legacy.body), { status: c.legacy.status, headers });
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const random = vi.spyOn(Math, "random").mockImplementation(rng(c.seed));
  const kv = {
    get: async (key: string, type: string) => {
      expect([key, type]).toEqual([HOST, "json"]);
      return c.kvValue;
    },
  };
  const env = Object.fromEntries(Object.keys(c.env).map((k) => [k, kv]));
  const worker = {
    async fetch(request: Request): Promise<Response> {
      const seen: [string, string][] = (await headersOf(request.headers)).filter(
        ([k]) => k !== "x-deco-ab-inner",
      );
      const body = c.workerReadsBody ? await request.text() : null;
      workerCalls.push({ url: request.url, method: request.method, headers: seen, body });
      if (c.worker === "throw") throw new Error("worker down");
      const headers = new Headers({ "content-type": "text/html" });
      for (const k of c.worker.cookies) headers.append("set-cookie", k);
      return new Response(c.worker.body, { status: c.worker.status, headers });
    },
  };
  const request = new Request(c.url, {
    method: c.method,
    headers: c.headers,
    body: c.body,
  });
  const out: Outcome = { legacyCalls, workerCalls, errors: 0 };
  try {
    const response = await serve(request, env, worker);
    out.response = {
      status: response.status,
      headers: await headersOf(response.headers),
      body: await response.text(),
    };
  } catch (error) {
    out.error = String(error);
  } finally {
    out.errors = errors.mock.calls.length;
    errors.mockRestore();
    random.mockRestore();
  }
  return out;
}

function configOf(c: Case): ABTestConfig {
  return {
    ...c.config,
    shouldBypassAB: c.bypass ? () => true : undefined,
    preHandler:
      c.preHandler === "none"
        ? undefined
        : () => (c.preHandler === "null" ? null : new Response("pre", { status: 418 })),
  };
}

/** A visitor who has been here before (the worker sends their cookie only on a first visit). */
const RETURNING = `deco_segment=${serializeVisitor(newVisitor())}`;

describe("abTestingRoutes is v7's withABTesting", () => {
  it(
    "same responses, legacy-origin calls, worker calls and errors over 3,000 seeded requests",
    FUZZ,
    async () => {
      const r = rng(0xab7e);
      const seen = { fallback: 0, worker: 0, breaker: 0, untouched: 0, cookie: 0 };
      for (let i = 0; i < 3_000; i++) {
        const c = randomCase(r);
        const expected = await run(c, (request, env, worker) =>
          v7.withABTesting(worker, configOf(c)).fetch(request, env, { waitUntil() {} }),
        );
        const actual = await run(c, (request, env, inner) => {
          // A worker with these routes: routes first, then the worker's own serving.
          const routes = abTestingRoutes<Record<string, unknown>>({
            worker: () => site,
            ...configOf(c),
          });
          const site = {
            fetch: async (req: Request, e: Record<string, unknown>, ctx: { waitUntil(): void }) =>
              (await routes(req, e, ctx)) ?? inner.fetch(req),
          };
          return site.fetch(request, env, { waitUntil() {} });
        });
        expect([i, actual]).toEqual([i, expected]);
        const bucket = expected.response?.headers.find(([k]) => k === "x-deco-bucket")?.[1];
        if (bucket === "fallback") seen.fallback++;
        else if (bucket === "worker") seen.worker++;
        else seen.untouched++;
        if (bucket === "fallback" && expected.workerCalls.length) seen.breaker++;
        if (
          expected.response?.headers.some(([k, v]) => k === "set-cookie" && v.includes("Max-Age"))
        )
          seen.cookie++;
      }
      expect(seen.fallback).toBeGreaterThan(400);
      expect(seen.worker).toBeGreaterThan(400);
      expect(seen.untouched).toBeGreaterThan(400);
      expect(seen.breaker).toBeGreaterThan(20);
      expect(seen.cookie).toBeGreaterThan(400);
    },
  );

  it(
    "v7's helpers on the same inputs: getStableBucket, tagBucket, createReplaceStream",
    FUZZ,
    async () => {
      const r = rng(0x5eed);
      for (let i = 0; i < 5_000; i++) {
        const c = randomCase(r);
        const ratio = pick(r, [0, 0.004, 0.006, 0.01, 0.2, 0.5, 0.505, 0.99, 1, Number.NaN, -3, 7]);
        const request = new Request(c.url, { headers: c.headers });
        const url = new URL(c.url);
        const name = c.config.cookieName;
        const seed = Math.floor(r() * 2 ** 31);
        let spy = vi.spyOn(Math, "random").mockImplementation(rng(seed));
        const expected = v7.getStableBucket(request, ratio, url, name);
        spy.mockRestore();
        spy = vi.spyOn(Math, "random").mockImplementation(rng(seed));
        expect([i, getStableBucket(request, ratio, url, name)]).toEqual([i, expected]);
        spy.mockRestore();
        const bucket = pick(r, ["worker", "fallback"] as const);
        const tagged = async (fn: typeof tagBucket) => {
          const res = fn(
            new Response("x"),
            bucket,
            HOST,
            request,
            ratio,
            name,
            c.config.cookieMaxAge,
          );
          return headersOf(res.headers);
        };
        expect([i, await tagged(tagBucket)]).toEqual([i, await tagged(v7.tagBucket)]);
      }
      for (let i = 0; i < 2_000; i++) {
        const search = pick(r, ["aaa", "legacy.example", "ç", "ab", "", "a"]);
        const text = Array.from({ length: Math.floor(r() * 60) }, () =>
          pick(r, ["a", "b", "ç", "legacy.example", "x", "🙂", "aa"]),
        ).join("");
        const seed = Math.floor(r() * 2 ** 31);
        const out = async (fn: typeof createReplaceStream) =>
          new Response(chunked(rng(seed), text).pipeThrough(fn(search, "site.example"))).text();
        expect([i, await out(createReplaceStream)]).toEqual([i, await out(v7.createReplaceStream)]);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Inside createDecoWorker
// ---------------------------------------------------------------------------

class MemoryCache {
  readonly entries = new Map<string, Response>();
  async match(key: Request) {
    return this.entries.get(key.url)?.clone();
  }
  async put(key: Request, response: Response) {
    this.entries.set(key.url, new Response(await response.arrayBuffer(), response));
  }
  async delete(key: Request) {
    return this.entries.delete(key.url);
  }
}

describe("abTestingRoutes at a Worker's global scope", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creating the handler draws no random value and does no I/O (Workers refuse both outside a handler)", () => {
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID");
    const random = vi.spyOn(Math, "random");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    abTestingRoutes({ worker: () => ({ fetch: async () => new Response("") }) });
    expect(uuid).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("abTestingRoutes in createDecoWorker", () => {
  let cache: MemoryCache;
  let n = 0;
  beforeEach(() => {
    cache = new MemoryCache();
    vi.stubGlobal("caches", { default: cache });
  });

  function setup(config: Partial<ABTestConfig> = {}, kv: SiteConfig | null = null) {
    n += 1;
    const cms: CMS = createCMS({
      blocks: {},
      content: { revision: "r1", blocks: {}, root: `/ab-${n}` } as Snapshot & { root: string },
    });
    const rendered: string[] = [];
    const legacy: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      legacy.push(url);
      return new Response(`<p>${LEGACY}</p>`, { headers: { "content-type": "text/html" } });
    });
    const abTesting = abTestingRoutes<Record<string, unknown>>({ worker: () => worker, ...config });
    const onCache = vi.fn();
    const worker = createDecoWorker<Record<string, unknown>>({
      serverEntry: {
        fetch: (request: Request) => {
          rendered.push(new URL(request.url).pathname);
          return new Response("<p>v8</p>", { headers: { "content-type": "text/html" } });
        },
      },
      cms,
      site: "loja",
      buildHash: "b1",
      preload: { styles: ["/assets/app.css"], fonts: ["/fonts/a.woff2"] },
      onCache,
      routes: async (request, env, ctx) =>
        (await abTesting(request, env, ctx)) ??
        (new URL(request.url).pathname === "/site-route" ? new Response("site route") : null),
    });
    const env = { SITES_KV: { get: async () => kv } };
    const work: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void work.push(p) };
    const get = async (path: string, headers: Record<string, string> = {}) => {
      // A returning visitor: the worker's own visitor cookie stays out of these bucket claims.
      const cookie = headers.cookie ? `${headers.cookie}; ${RETURNING}` : RETURNING;
      const init = { headers: { ...headers, cookie } };
      const res = await worker.fetch(new Request(`https://${HOST}${path}`, init), env, ctx);
      await Promise.allSettled(work.splice(0));
      return res;
    };
    return { get, rendered, legacy, onCache };
  }

  const config: SiteConfig = { workerName: "w", fallbackOrigin: LEGACY, abTest: { ratio: 0.5 } };
  const links = (res: Response) => (res.headers.get("link") ?? "").split(/,\s*(?=<)/);

  it("the worker bucket: the page once, tagged, with the worker's headers once", async () => {
    const { get, rendered, legacy, onCache } = setup({}, config);
    const res = await get("/p", { cookie: "_deco_bucket=worker:50" });
    expect(await res.text()).toBe("<p>v8</p>");
    expect(res.headers.get("x-deco-bucket")).toBe("worker");
    // The cookie already says worker:50: nothing to set.
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(links(res)).toEqual([
      "</assets/app.css>; rel=preload; as=style",
      "</fonts/a.woff2>; rel=preload; as=font; crossorigin",
    ]);
    expect(res.headers.get("x-cache")).toBe("MISS");
    expect(rendered).toEqual(["/p"]);
    expect(legacy).toEqual([]);
    expect(onCache).toHaveBeenCalledTimes(1);

    // A cached page is tagged too, and the override sets the cookie.
    const hit = await get("/p", { cookie: "_deco_bucket=worker:50" });
    expect([hit.headers.get("x-cache"), hit.headers.get("x-deco-bucket")]).toEqual([
      "HIT",
      "worker",
    ]);
    const again = await get("/p?_deco_bucket=worker");
    expect(again.headers.get("x-deco-bucket")).toBe("worker");
    expect(again.headers.getSetCookie()).toEqual([
      `_deco_bucket=worker:50; Path=/; Max-Age=31536000; Domain=${HOST}; SameSite=Lax`,
    ]);
    expect(rendered).toEqual(["/p", "/p"]); // the HIT rendered nothing; the override is another URL
  });

  it("the fallback bucket: the legacy origin's page, hostname rewritten, the worker never renders", async () => {
    const { get, rendered, legacy } = setup({}, config);
    const res = await get("/p", { cookie: "_deco_bucket=fallback:50" });
    expect(await res.text()).toBe(`<p>${HOST}</p>`);
    expect(res.headers.get("x-deco-bucket")).toBe("fallback");
    expect(legacy).toEqual([`https://${LEGACY}/p`]);
    expect(rendered).toEqual([]);
  });

  it("the fallback bucket's page carries none of the new site's preload hints, as in v7", async () => {
    const { get } = setup({}, config);
    const res = await get("/p", { cookie: "_deco_bucket=fallback:50" });
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-deco-bucket")).toBe("fallback");
    expect(res.headers.has("link")).toBe(false);
  });

  it("the site's other routes still answer in the worker bucket; bypassed and unconfigured requests go untagged", async () => {
    const bypass = setup({ shouldBypassAB: (_r, url) => url.pathname === "/checkout" }, config);
    const routed = await bypass.get("/site-route", { cookie: "_deco_bucket=worker:50" });
    expect([await routed.text(), routed.headers.get("x-deco-bucket")]).toEqual([
      "site route",
      "worker",
    ]);
    const skipped = await bypass.get("/checkout", { cookie: "_deco_bucket=fallback:50" });
    expect(skipped.headers.get("x-deco-bucket")).toBeNull();
    expect(bypass.legacy).toEqual([]);

    const none = setup({}, null);
    const res = await none.get("/p", { cookie: "_deco_bucket=fallback:50" });
    expect([await res.text(), res.headers.get("x-deco-bucket")]).toEqual(["<p>v8</p>", null]);
  });

  it("a client can't skip the split with the inner-call header", async () => {
    const { get, legacy } = setup({}, config);
    const res = await get("/p", { cookie: "_deco_bucket=fallback:50", "x-deco-ab-inner": "guess" });
    expect(res.headers.get("x-deco-bucket")).toBe("fallback");
    expect(legacy).toHaveLength(1);
  });
});
