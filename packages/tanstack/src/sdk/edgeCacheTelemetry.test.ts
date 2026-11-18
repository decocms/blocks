// @vitest-environment node

import { setBlocks } from "@decocms/blocks/cms";
import { clearLoaderCache } from "@decocms/blocks/sdk/cachedLoader";
import { type CacheKVNamespace, createKVCacheStorage } from "@decocms/blocks/sdk/cacheStorage";
import { configureTracer, type TracerAdapter } from "@decocms/blocks/sdk/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheKeyParts,
  EdgeCacheAttr,
  fnv1aHex,
  segmentShape,
  unsafeCookieNames,
} from "./edgeCacheTelemetry";
import { createDecoWorkerEntry } from "./workerEntry";

// decocms/blocks#824: the edge cache HIT rate of a production storefront sat far
// below what its own traffic allowed, and nothing the framework emitted could
// tell key fragmentation, colo spread and failed stores apart. These tests pin
// what each request records on its span — and that no visitor value leaks.

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("segmentShape", () => {
  it("keeps device, auth and sales channel; reduces every other field to its name", () => {
    expect(segmentShape("mobile|sc=1|r=v2.ABCDEF|gps=-23.55,-46.63|priceTables=1,7")).toBe(
      "mobile|sc=1|r|gps|priceTables",
    );
    expect(segmentShape("desktop|auth|sc=2")).toBe("desktop|auth|sc=2");
    expect(segmentShape("mobile|f=a,b|member")).toBe("mobile|f|member");
    expect(segmentShape("")).toBe("");
  });
});

describe("fnv1aHex", () => {
  it("matches the fnv1a sites already use on X-Cache-Segment (Math.abs, hex)", () => {
    // Reference values from the 32-bit FNV-1a spec, through Math.abs.
    expect(fnv1aHex("")).toBe("811c9dc5");
    expect(fnv1aHex("a")).toBe(Math.abs(0xe40c292c | 0).toString(16));
    expect(fnv1aHex("mobile|sc=1")).toBe(fnv1aHex("mobile|sc=1"));
    expect(fnv1aHex("mobile|sc=1")).not.toBe(fnv1aHex("mobile|sc=2"));
  });
});

describe("cacheKeyParts", () => {
  it("lists the extra key dimensions by name only", () => {
    expect(
      cacheKeyParts("https://s.test/?__v=abc&__cf_geo=BR%7CSP&__bot=1&__abf=x&__seg=mobile"),
    ).toBe("abf,bot,cf_geo");
    expect(cacheKeyParts("https://s.test/p?__v=abc&__fetch=1&__cf_device=mobile")).toBe(
      "fetch,cf_device",
    );
    expect(cacheKeyParts("https://s.test/?__v=abc&__seg=mobile")).toBe("");
  });
});

describe("unsafeCookieNames", () => {
  it("names the cookies outside the safe list, never their values", () => {
    const res = new Response("x");
    res.headers.append("set-cookie", "vtex_segment=abc; Path=/");
    res.headers.append("set-cookie", "vtex_session=SECRET1; Path=/; HttpOnly");
    res.headers.append("set-cookie", "checkout.vtex.com=__ofid=SECRET2; Path=/");
    res.headers.append("set-cookie", "vtex_session=SECRET3; Domain=.shop.test");
    const names = unsafeCookieNames(res, new Set(["vtex_segment"]));
    expect(names).toBe("vtex_session,checkout.vtex.com");
    expect(names).not.toContain("SECRET");
  });
});

// ---------------------------------------------------------------------------
// Worker entry: what lands on the request span
// ---------------------------------------------------------------------------

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  ended: boolean;
}
let spans: RecordedSpan[] = [];
const recordingTracer: TracerAdapter = {
  startSpan(name, attributes) {
    const rec: RecordedSpan = { name, attributes: { ...(attributes ?? {}) }, ended: false };
    spans.push(rec);
    return {
      end() {
        rec.ended = true;
      },
      setAttribute(key, value) {
        rec.attributes[key] = value;
      },
      setError() {
        rec.attributes["test.error"] = true;
      },
    };
  },
};
const rootSpan = () => spans.filter((s) => s.name === "deco.http.request").at(-1)!;
const storeSpans = () => spans.filter((s) => s.name === "deco.cache.store");

function makeKV(failPut = false): CacheKVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => {
      if (failPut) throw new Error("kv put failed");
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
}

const jobs: Promise<unknown>[] = [];
const ctx = { waitUntil: (w: Promise<unknown>) => jobs.push(w), passThroughOnException() {} };
async function flush() {
  while (jobs.length) await Promise.allSettled(jobs.splice(0));
}

const GPS = "-23.5505,-46.6333";
const options = {
  observability: false as const,
  outboundUserAgent: false as const,
  geoCacheKey: "off" as const,
  buildSegment: (req: Request) => ({
    device: "mobile" as const,
    loggedIn: (req.headers.get("cookie") ?? "").includes("VtexIdclientAutCookie"),
    salesChannel: "1",
    regionId: "v2.SECRETREGION",
    gps: GPS,
  }),
  cacheStorage: (bindings: Record<string, unknown>) =>
    createKVCacheStorage(bindings.CACHE as CacheKVNamespace),
};
const env = (failPut = false) => ({ CACHE: makeKV(failPut), BUILD_HASH: "0123456789abcdef" });

const htmlOrigin = (init?: ResponseInit) => ({
  fetch: vi.fn(
    async () =>
      new Response("<html>ok</html>", {
        ...init,
        headers: { "content-type": "text/html", ...(init?.headers ?? {}) },
      }),
  ),
});

function page(path: string, headers: Record<string, string> = {}) {
  const req = new Request(`https://shop.test${path}`, {
    headers: { accept: "text/html", ...headers },
  });
  // workerd attaches `cf`; Node's Request does not.
  Object.defineProperty(req, "cf", { value: { colo: "GRU" } });
  return req;
}

/** Every attribute value on every span, for the "no visitor value" assertion. */
const allValues = () => spans.flatMap((s) => Object.values(s.attributes).map(String)).join("\n");

beforeEach(() => {
  clearLoaderCache();
  setBlocks({});
  spans = [];
  configureTracer(recordingTracer);
});

afterEach(async () => {
  await flush();
  configureTracer(null as unknown as TracerAdapter);
  vi.restoreAllMocks();
});

describe("edge cache telemetry on the request span", () => {
  it("MISS that is stored: key dimensions, put, and the settled store outcome", async () => {
    const worker = createDecoWorkerEntry(htmlOrigin(), options);
    const res = await worker.fetch(page("/"), env(), ctx);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    await flush();

    const attrs = rootSpan().attributes;
    expect(attrs[EdgeCacheAttr.STATUS]).toBe("MISS");
    expect(attrs[EdgeCacheAttr.KIND]).toBe("html");
    expect(attrs[EdgeCacheAttr.PROFILE]).toBe(res.headers.get("X-Cache-Profile"));
    expect(attrs[EdgeCacheAttr.VERSION]).toBe("01234567");
    expect(attrs[EdgeCacheAttr.COLO]).toBe("GRU");
    expect(attrs[EdgeCacheAttr.SEGMENT_SHAPE]).toBe("mobile|sc=1|r|gps");
    // Same hash a site computes from the X-Cache-Segment header it receives.
    expect(attrs[EdgeCacheAttr.SEGMENT_HASH]).toBe(
      fnv1aHex(res.headers.get("X-Cache-Segment") ?? ""),
    );
    expect(attrs[EdgeCacheAttr.KEY_HASH]).toMatch(/^[0-9a-f]+$/);
    expect(attrs[EdgeCacheAttr.KEY_PARTS]).toBe("");
    expect(attrs[EdgeCacheAttr.STORE]).toBe("put");
    expect(attrs[EdgeCacheAttr.BYPASS_REASON]).toBeUndefined();

    expect(storeSpans()).toHaveLength(1);
    expect(storeSpans()[0].attributes[EdgeCacheAttr.STORE_OUTCOME]).toBe("stored");

    expect(allValues()).not.toContain(GPS);
    expect(allValues()).not.toContain("SECRETREGION");
  });

  it("HIT: same key hash as the MISS that filled it, no store", async () => {
    const worker = createDecoWorkerEntry(htmlOrigin(), options);
    const bindings = env();
    await worker.fetch(page("/"), bindings, ctx);
    await flush();
    const missKey = rootSpan().attributes[EdgeCacheAttr.KEY_HASH];

    spans = [];
    const res = await worker.fetch(page("/"), bindings, ctx);
    expect(res.headers.get("X-Cache")).toBe("HIT");

    const attrs = rootSpan().attributes;
    expect(attrs[EdgeCacheAttr.STATUS]).toBe("HIT");
    expect(attrs[EdgeCacheAttr.KEY_HASH]).toBe(missKey);
    expect(attrs[EdgeCacheAttr.COLO]).toBe("GRU");
    expect(attrs[EdgeCacheAttr.SEGMENT_SHAPE]).toBe("mobile|sc=1|r|gps");
    expect(attrs[EdgeCacheAttr.STORE]).toBeUndefined();
    expect(storeSpans()).toHaveLength(0);
  });

  it("MISS not stored because of an unsafe Set-Cookie: names the cookies, not their values", async () => {
    const origin = {
      fetch: vi.fn(async () => {
        const r = new Response("<html>ok</html>", { headers: { "content-type": "text/html" } });
        r.headers.append("set-cookie", "vtex_segment=public; Path=/");
        r.headers.append("set-cookie", "vtex_session=TOKEN123; Path=/; HttpOnly");
        return r;
      }),
    };
    const worker = createDecoWorkerEntry(origin, options);
    const res = await worker.fetch(page("/"), env(), ctx);
    // The response is labelled BYPASS; the span keeps the lookup's MISS.
    expect(res.headers.get("X-Cache")).toBe("BYPASS");
    expect(res.headers.get("X-Cache-Reason")).toBe("private-set-cookie");
    await flush();

    const attrs = rootSpan().attributes;
    expect(attrs[EdgeCacheAttr.STATUS]).toBe("MISS");
    expect(attrs[EdgeCacheAttr.STORE]).toBe("skipped:unsafe-cookie");
    expect(attrs[EdgeCacheAttr.STORE_UNSAFE_COOKIES]).toBe("vtex_session");
    expect(storeSpans()).toHaveLength(0);
    expect(allValues()).not.toContain("TOKEN123");
  });

  it("BYPASS for a logged-in visitor: reason, no key or store", async () => {
    const worker = createDecoWorkerEntry(htmlOrigin(), options);
    const res = await worker.fetch(
      page("/", { cookie: "VtexIdclientAutCookie_store=JWTVALUE" }),
      env(),
      ctx,
    );
    expect(res.headers.get("X-Cache")).toBe("BYPASS");

    const attrs = rootSpan().attributes;
    expect(attrs[EdgeCacheAttr.STATUS]).toBe("BYPASS");
    expect(attrs[EdgeCacheAttr.BYPASS_REASON]).toBe("logged-in");
    expect(attrs[EdgeCacheAttr.KIND]).toBe("html");
    expect(attrs[EdgeCacheAttr.COLO]).toBe("GRU");
    expect(attrs[EdgeCacheAttr.STORE]).toBeUndefined();
    expect(allValues()).not.toContain("JWTVALUE");
  });

  it("BYPASS for a non-GET document request names the method", async () => {
    const worker = createDecoWorkerEntry(htmlOrigin(), options);
    await worker.fetch(
      new Request("https://shop.test/contact", { method: "PUT", body: "x" }),
      env(),
      ctx,
    );
    expect(rootSpan().attributes[EdgeCacheAttr.BYPASS_REASON]).toBe("method:PUT");
  });

  it("records extra key parts (bot, fetch) by name", async () => {
    const worker = createDecoWorkerEntry(htmlOrigin(), options);
    await worker.fetch(
      page("/", { "user-agent": "Googlebot/2.1", "sec-fetch-dest": "empty" }),
      env(),
      ctx,
    );
    expect(rootSpan().attributes[EdgeCacheAttr.KEY_PARTS]).toBe("bot,fetch");
  });

  it("a failed cache.put shows up as outcome=error on the store span", async () => {
    const worker = createDecoWorkerEntry(htmlOrigin(), options);
    await worker.fetch(page("/"), env(true), ctx);
    await flush();
    expect(rootSpan().attributes[EdgeCacheAttr.STORE]).toBe("put");
    expect(storeSpans()[0].attributes[EdgeCacheAttr.STORE_OUTCOME]).toBe("error");
  });

  it("POST server fn: kind, key and store decision; a Set-Cookie lists every name", async () => {
    const sfn = (cookie?: string) => ({
      fetch: vi.fn(async () => {
        const r = new Response("{}", {
          headers: { "content-type": "application/json", "X-Deco-Cacheable": "true" },
        });
        if (cookie) r.headers.append("set-cookie", cookie);
        return r;
      }),
    });
    const post = () => {
      const req = new Request("https://shop.test/_serverFn/abc", { method: "POST", body: "{}" });
      Object.defineProperty(req, "cf", { value: { colo: "GIG" } });
      return req;
    };

    await createDecoWorkerEntry(sfn(), options).fetch(post(), env(), ctx);
    await flush();
    let attrs = rootSpan().attributes;
    expect(attrs[EdgeCacheAttr.KIND]).toBe("serverFn");
    expect(attrs[EdgeCacheAttr.STATUS]).toBe("MISS");
    expect(attrs[EdgeCacheAttr.COLO]).toBe("GIG");
    expect(attrs[EdgeCacheAttr.STORE]).toBe("put");
    expect(storeSpans()[0].attributes[EdgeCacheAttr.STORE_OUTCOME]).toBe("stored");

    spans = [];
    await createDecoWorkerEntry(sfn("vtex_segment=v; Path=/"), options).fetch(post(), env(), ctx);
    attrs = rootSpan().attributes;
    expect(attrs[EdgeCacheAttr.STORE]).toBe("skipped:set-cookie");
    expect(attrs[EdgeCacheAttr.STORE_UNSAFE_COOKIES]).toBe("vtex_segment");
  });

  it("is observation only: the opt-out stamps nothing and serves the same", async () => {
    const on = createDecoWorkerEntry(htmlOrigin(), options);
    const off = createDecoWorkerEntry(htmlOrigin(), { ...options, edgeCacheTelemetry: false });
    const bOn = env();
    const bOff = env();
    const seqOn: Array<string | null> = [];
    const seqOff: Array<string | null> = [];
    for (let i = 0; i < 2; i++) {
      seqOn.push((await on.fetch(page("/"), bOn, ctx)).headers.get("X-Cache"));
      await flush();
    }
    spans = [];
    for (let i = 0; i < 2; i++) {
      seqOff.push((await off.fetch(page("/"), bOff, ctx)).headers.get("X-Cache"));
      await flush();
    }
    expect(seqOff).toEqual(seqOn);
    expect(seqOn).toEqual(["MISS", "HIT"]);
    const keys = spans.flatMap((s) => Object.keys(s.attributes));
    for (const attr of [
      EdgeCacheAttr.KEY_HASH,
      EdgeCacheAttr.SEGMENT_SHAPE,
      EdgeCacheAttr.STORE,
      EdgeCacheAttr.STORE_OUTCOME,
    ]) {
      expect(keys).not.toContain(attr);
    }
  });
});
