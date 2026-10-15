/**
 * `@decocms/compat-v7/tanstack/worker`: v7's A/B split between the site and
 * its legacy origin (`@decocms/blocks@7` sdk/abTesting.ts, `withABTesting`),
 * as a `routes` handler for `@decocms/tanstack`'s `createDecoWorker`. Same
 * KV config (`SiteConfig` under the request's hostname), the same buckets,
 * the same `_deco_bucket` cookie (`<bucket>:<ratioPct>`), the same
 * `?_deco_bucket=` override, circuit breaker and fallback proxy, byte for
 * byte; `src/tanstack/abTesting.test.ts` runs v7's own file next to it.
 *
 * v7 wrapped the whole worker. Here the worker calls the handler from its
 * `routes`, after its CMS redirects, and the handler calls the worker back
 * (`worker`) for the visitors in the "worker" bucket, so their response gets
 * the bucket cookie and a worker error falls back to the legacy origin, as in
 * v7. That inner call skips the handler and goes on to the site's other
 * routes, the edge cache and the page.
 *
 * ```ts
 * // src/worker-entry.ts
 * import { abTestingRoutes } from "@decocms/compat-v7/tanstack/worker";
 *
 * const abTesting = abTestingRoutes({
 *   worker: () => worker,
 *   kvBinding: "SITES_KV",
 *   shouldBypassAB: (_request, url) => isCommercePath(url.pathname),
 * });
 *
 * const worker = createDecoWorker({
 *   // …
 *   routes: async (request, env, ctx) =>
 *     (await abTesting(request, env, ctx)) ?? siteRoutes(request),
 * });
 * export default worker;
 * ```
 *
 * Imports nothing but Web APIs: it runs in the worker, never in a page.
 */

/** The part of Cloudflare's `ExecutionContext` the handler passes on. */
export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/** The worker the handler calls back for the "worker" bucket (`createDecoWorker`'s result). */
export interface WorkerHandler<Env = unknown> {
  fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response>;
}

interface KVNamespace {
  get<T = string>(key: string, type: "json"): Promise<T | null>;
}

/** KV value shape — same as the original cf-gateway config. */
export interface SiteConfig {
  workerName: string;
  fallbackOrigin: string;
  abTest?: { ratio: number };
}

export type Bucket = "worker" | "fallback";

/** v7's `ABTestConfig`, option for option. */
export interface ABTestConfig {
  /** KV namespace binding name. @default "SITES_KV" */
  kvBinding?: string;
  /** Cookie name for bucket persistence. @default "_deco_bucket" */
  cookieName?: string;
  /** Cookie max-age in seconds. @default 31536000 (1 year) */
  cookieMaxAge?: number;
  /** Auto-fallback to legacy on worker errors. @default true */
  circuitBreaker?: boolean;
  /**
   * Return `true` to bypass A/B for this request — always serve from the
   * worker regardless of bucket assignment (checkout, `/api/*`).
   */
  shouldBypassAB?: (request: Request, url: URL) => boolean;
  /**
   * Called before the A/B logic runs. Return a `Response` to short-circuit,
   * or `null` to continue with A/B. (The worker has already answered its
   * CMS redirects before its `routes` run.)
   */
  preHandler?: (request: Request, url: URL) => Response | Promise<Response | null> | null;
}

export interface ABTestRoutesOptions<Env = unknown> extends ABTestConfig {
  /**
   * The worker whose `routes` call the handler, read when a request lands in
   * the "worker" bucket (so `() => worker` works before `worker` is defined).
   */
  worker: () => WorkerHandler<Env>;
}

/** A `createDecoWorker` `routes` handler: a response, or `null` to let the worker serve. */
export type ABTestRoutes<Env = unknown> = (
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
) => Promise<Response | null>;

// ---------------------------------------------------------------------------
// FNV-1a 32-bit — fast, good distribution for short strings like IPs.
// Same hash used by the original cf-gateway.
// ---------------------------------------------------------------------------

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash);
}

/**
 * Hop-by-hop headers per RFC 7230 §6.1 — must not be forwarded through
 * proxies. Plus `host`, which is always rewritten to the target origin.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k, v.join("=")];
    }),
  );
}

const RATIO_PCT_MAX = 100;

/** A 0–1 ratio as the 0–100 integer percentage the bucketing and the cookie use. */
function ratioToPct(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio >= 1) return RATIO_PCT_MAX;
  return Math.round(ratio * RATIO_PCT_MAX);
}

/**
 * The bucket cookie, `worker:50` (bucket + the ratio percentage it was set
 * under). Legacy formats (a unix timestamp, a bare bucket) read as missing.
 */
function parseBucketCookie(raw: string | undefined): { bucket: Bucket; ratioPct: number } | null {
  if (!raw) return null;

  const colonIdx = raw.indexOf(":");
  if (colonIdx <= 0) return null;

  const bucket = raw.slice(0, colonIdx);
  if (bucket !== "worker" && bucket !== "fallback") return null;

  const ratioPct = Number.parseInt(raw.slice(colonIdx + 1), 10);
  if (Number.isNaN(ratioPct) || ratioPct < 0 || ratioPct > RATIO_PCT_MAX) return null;

  return { bucket, ratioPct };
}

/**
 * The visitor's bucket: the query override (`?_deco_bucket=worker`), else a
 * cookie set under the current ratio, else the client IP's FNV-1a hash
 * against the ratio (a random draw without `cf-connecting-ip`).
 */
export function getStableBucket(
  request: Request,
  ratio: number,
  url: URL,
  cookieName: string = "_deco_bucket",
): Bucket {
  const override = url.searchParams.get(cookieName);
  if (override === "worker" || override === "fallback") return override;

  const currentRatioPct = ratioToPct(ratio);
  const cookies = parseCookies(request.headers.get("cookie") ?? "");
  const parsed = parseBucketCookie(cookies[cookieName]);
  if (parsed && parsed.ratioPct === currentRatioPct) return parsed.bucket;

  if (currentRatioPct <= 0) return "fallback";
  if (currentRatioPct >= RATIO_PCT_MAX) return "worker";

  const ip = request.headers.get("cf-connecting-ip") ?? Math.random().toString();
  return fnv1a(ip) % RATIO_PCT_MAX < currentRatioPct ? "worker" : "fallback";
}

/**
 * The response with `x-deco-bucket`, and the bucket cookie when the
 * visitor's cookie says another bucket or another ratio.
 */
export function tagBucket(
  response: Response,
  bucket: Bucket,
  hostname: string,
  request: Request,
  ratio: number,
  cookieName: string = "_deco_bucket",
  maxAge: number = 60 * 60 * 24 * 365,
): Response {
  const res = new Response(response.body, response);
  res.headers.set("x-deco-bucket", bucket);

  const currentRatioPct = ratioToPct(ratio);
  const cookies = parseCookies(request.headers.get("cookie") ?? "");
  const parsed = parseBucketCookie(cookies[cookieName]);

  const needsSet = !parsed || parsed.bucket !== bucket || parsed.ratioPct !== currentRatioPct;

  if (needsSet) {
    res.headers.append(
      "set-cookie",
      `${cookieName}=${bucket}:${currentRatioPct}; Path=/; Max-Age=${maxAge}; Domain=${hostname}; SameSite=Lax`,
    );
  }

  return res;
}

/**
 * A stream that replaces every `search` in UTF-8 text without holding the
 * body: it keeps back the last `search.length - 1` characters of the raw
 * input for the next chunk, and decodes split multi-byte characters across
 * chunks.
 */
export function createReplaceStream(
  search: string,
  replace: string,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  if (!search) return new TransformStream<Uint8Array, Uint8Array>();
  const keep = search.length - 1;
  let tail = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const buffer = tail + decoder.decode(chunk, { stream: true });
      // Complete matches first (left to right, non-overlapping, as
      // replaceAll), then hold back what could start an unfinished one.
      let end = 0;
      for (let i = buffer.indexOf(search); i !== -1; i = buffer.indexOf(search, end)) {
        end = i + search.length;
      }
      const cut = Math.max(end, buffer.length - keep);
      tail = buffer.slice(cut);
      const head = buffer.slice(0, cut);
      if (head) controller.enqueue(encoder.encode(head.replaceAll(search, replace)));
    },
    flush(controller) {
      const rest = tail + decoder.decode();
      if (rest) controller.enqueue(encoder.encode(rest.replaceAll(search, replace)));
    },
  });
}

/**
 * The request sent to the legacy origin, with its hostname written back to
 * the site's: `Set-Cookie` domains, `Location`, and the text of 2xx bodies
 * (streamed). Redirects are never followed (`redirect: "manual"`): the body
 * was streamed and can't be replayed.
 */
export async function proxyToFallback(
  request: Request,
  url: URL,
  fallbackOrigin: string,
): Promise<Response> {
  const target = new URL(url.toString());
  target.hostname = fallbackOrigin;

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lk = key.toLowerCase();
    if (lk === "host") continue;
    if (HOP_BY_HOP_HEADERS.has(lk)) continue;
    headers.set(key, value);
  }
  headers.set("x-forwarded-host", url.hostname);

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  const response = await fetch(target.toString(), init);

  const ct = response.headers.get("content-type") ?? "";
  const isText = ct.includes("text/") || ct.includes("json") || ct.includes("javascript");

  let body: BodyInit | null = response.body;
  let rewrote = false;
  if (
    isText &&
    response.body &&
    response.status >= 200 &&
    response.status < 300 &&
    fallbackOrigin.length > 0
  ) {
    body = response.body.pipeThrough(createReplaceStream(fallbackOrigin, url.hostname));
    rewrote = true;
  }

  const rewritten = new Response(body, response);

  // The rewrite changes the body's length.
  if (rewrote) rewritten.headers.delete("content-length");

  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    rewritten.headers.delete("set-cookie");
    for (const cookie of setCookies) {
      rewritten.headers.append(
        "set-cookie",
        cookie.replace(
          new RegExp(`Domain=\\.?${fallbackOrigin.replace(/\./g, "\\.")}`, "gi"),
          `Domain=.${url.hostname}`,
        ),
      );
    }
  }

  const location = response.headers.get("location");
  if (location?.includes(fallbackOrigin)) {
    rewritten.headers.set("location", location.replaceAll(fallbackOrigin, url.hostname));
  }

  return rewritten;
}

/** Marks the handler's own call back into the worker (per handler, so a client can't forge it). */
const INNER_HEADER = "x-deco-ab-inner";

/**
 * `Link` values `createDecoWorker` appends to every HTML response it sends
 * (`preload.styles`, `preload.fonts`). The inner call's response already has
 * them and the outer call adds them again, so they come off the inner one.
 */
const WORKER_PRELOAD = /^<[^>]*>; rel=preload; as=(?:style|font; crossorigin)$/;

function withoutWorkerPreloads(response: Response): Response {
  const link = response.headers.get("link");
  if (!link) return response;
  const kept = link.split(/,\s*(?=<)/).filter((value) => !WORKER_PRELOAD.test(value.trim()));
  const out = new Response(response.body, response);
  if (kept.length) out.headers.set("link", kept.join(", "));
  else out.headers.delete("link");
  return out;
}

/**
 * v7's `withABTesting` as a `createDecoWorker` `routes` handler. Without the
 * KV binding, without a config for the hostname, or when `shouldBypassAB`
 * says so, it returns `null` and the worker serves the request. Otherwise
 * the "fallback" bucket gets the legacy origin's response and the "worker"
 * bucket the worker's, each tagged with the bucket.
 */
export function abTestingRoutes<Env = unknown>(
  options: ABTestRoutesOptions<Env>,
): ABTestRoutes<Env> {
  const {
    worker,
    kvBinding = "SITES_KV",
    cookieName = "_deco_bucket",
    cookieMaxAge = 60 * 60 * 24 * 365,
    circuitBreaker = true,
    shouldBypassAB,
    preHandler,
  } = options;
  const innerToken = crypto.randomUUID();

  return async (request, env, ctx) => {
    // The handler's own call back into the worker: let the worker serve it.
    if (request.headers.get(INNER_HEADER) === innerToken) return null;

    const url = new URL(request.url);

    if (preHandler) {
      const pre = await preHandler(request, url);
      if (pre) return pre;
    }

    const kv = (env as Record<string, unknown> | undefined)?.[kvBinding] as KVNamespace | undefined;
    if (!kv) return null;

    const siteConfig = await kv.get<SiteConfig>(url.hostname, "json");
    if (!siteConfig?.fallbackOrigin) return null;

    if (shouldBypassAB?.(request, url)) return null;

    const ratio = siteConfig.abTest?.ratio ?? 0;
    const bucket = getStableBucket(request, ratio, url, cookieName);
    const tag = (response: Response, as: Bucket) =>
      tagBucket(response, as, url.hostname, request, ratio, cookieName, cookieMaxAge);

    // The legacy origin gets a copy, so the worker can still read the body
    // when the proxy fails after reading it.
    const fallbackRequest = request.clone();

    try {
      if (bucket === "fallback") {
        return tag(await proxyToFallback(fallbackRequest, url, siteConfig.fallbackOrigin), bucket);
      }

      try {
        const headers = new Headers(request.headers);
        headers.set(INNER_HEADER, innerToken);
        const response = await worker().fetch(new Request(request, { headers }), env, ctx);
        return tag(withoutWorkerPreloads(response), bucket);
      } catch (err) {
        if (!circuitBreaker) throw err;
        console.error("[A/B] Worker error, circuit breaker → fallback:", err);
        return tag(
          await proxyToFallback(fallbackRequest, url, siteConfig.fallbackOrigin),
          "fallback",
        );
      }
    } catch (err) {
      // v7 then called the worker once more, untagged: the worker serves it.
      console.error("[A/B] Fatal proxy error, passing through to handler:", err);
      return null;
    }
  };
}
