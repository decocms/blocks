import { djb2Hex } from "@decocms/blocks/sdk/djb2";
import {
  composeMeta,
  getDeploymentId,
  type MetaResponse,
  metaEtagKey,
  metaKey,
} from "@decocms/blocks/cms";
import { getRuntimeEnv } from "@decocms/blocks/sdk/otelAdapters";

// Use globalThis to share meta state across module instances.
// The daemon middleware imports this module via native import() (outside Vite SSR),
// while setup.ts calls setMetaData() via Vite SSR — these are different module instances.
// globalThis bridges them so both see the same metaData.
const G = globalThis as unknown as {
  __deco_meta_data?: MetaResponse | null;
  __deco_meta_etag?: string | null;
  __deco_meta_provider?: (() => Promise<MetaResponse>) | null;
  __deco_meta_loading?: Promise<MetaResponse> | null;
};

/** KV handle for the admin schema, injected by the binding that has one.
 *
 * Same dependency-injection shape as `setFastDeployKVGetter` in decofile.ts,
 * and for the same reason: KV is a Cloudflare/tanstack concern and
 * `blocks-admin` must not import from `tanstack`. `next` never calls the
 * setter, so the KV branch below is simply never taken there. */
// biome-ignore lint/complexity/noBannedTypes: mirrors decofile.ts — the real
// KVNamespace type lives in @cloudflare/workers-types, which this package
// deliberately does not depend on.
type MetaKVGetter = (env: Record<string, unknown>) => { get: Function } | null;

let getMetaKV: MetaKVGetter = () => null;

/**
 * Inject the KV handle used to serve `GET /live/_meta` without keeping the
 * schema in the isolate. Call once at startup — `@decocms/tanstack` does it
 * from `setupTanstackFastDeploy()`.
 */
export function setMetaKVGetter(getter: MetaKVGetter): void {
  getMetaKV = getter;
}

function getMetaData(): MetaResponse | null {
  return G.__deco_meta_data ?? null;
}

function setMetaDataInternal(data: MetaResponse | null) {
  G.__deco_meta_data = data;
}

function getCachedEtag(): string | null {
  return G.__deco_meta_etag ?? null;
}

function setCachedEtag(etag: string | null) {
  G.__deco_meta_etag = etag;
}

/**
 * Invalidate the cached ETag so the admin re-fetches meta after a
 * hot-reload or decofile change.
 *
 * Called by decofile.ts after setBlocks() — no server-side loader import
 * needed here, keeping this module safe for client-side bundles.
 */
export function invalidateMetaCache() {
  setCachedEtag(null);
}

/**
 * Set the schema metadata that /deco/meta will return.
 * Runs composeMeta() to inject framework-level schemas (pages, etc.)
 * on top of the site-generated section schemas.
 */
export function setMetaData(data: MetaResponse) {
  setMetaDataInternal(composeMeta(data));
  setCachedEtag(null);
}

/**
 * Register the schema as a thunk instead of a value: it is only imported,
 * parsed and composed the first time /live/_meta is hit, then memoised for
 * the life of the isolate.
 *
 * This matters on Workers — the composed schema is tens of MB of heap on a
 * large site (montecarlo: ~40 MB of a 128 MB budget) and nothing on the
 * render path reads it. Eagerly awaiting the thunk at boot, as this used to
 * do, made every isolate pay for an endpoint the admin calls a few times a
 * day.
 *
 * ponytail: this only drops the *parsed* schema. The module's source text is
 * still retained by V8 because it's in the server bundle; removing that needs
 * the schema to leave the bundle entirely (static asset or KV).
 */
export function setMetaProvider(provider: () => Promise<MetaResponse>) {
  G.__deco_meta_provider = provider;
  G.__deco_meta_loading = null;
  setMetaDataInternal(null);
  setCachedEtag(null);
}

/** Resolve the schema from cache, else from the registered provider (once). */
function loadMetaData(): MetaResponse | Promise<MetaResponse | null> | null {
  const cached = getMetaData();
  if (cached) return cached;

  const provider = G.__deco_meta_provider;
  if (!provider) return null;

  G.__deco_meta_loading ??= Promise.resolve()
    .then(provider)
    .then((data) => {
      setMetaData(data);
      return getMetaData()!;
    })
    .catch((error) => {
      // Don't poison the isolate: a transient import/fetch failure should be
      // retried by the next request, not cached as a permanent 503.
      G.__deco_meta_loading = null;
      throw error;
    });

  return G.__deco_meta_loading;
}

/**
 * Content-based hash for ETag.
 * Uses DJB2 over the serialised JSON so any definition change
 * results in a different ETag, forcing admin to re-fetch.
 */
function getEtag(): string {
  let etag = getCachedEtag();
  if (!etag) {
    const str = JSON.stringify(getMetaData() || {});
    etag = `"meta-${djb2Hex(str)}"`;
    setCachedEtag(etag);
  }
  return etag;
}

/**
 * Serve the schema straight from KV, as bytes.
 *
 * The whole point is that nothing here ever parses the payload: a large site's
 * schema is ~10 MB of JSON, and holding it as a parsed object (or even as a
 * string) costs tens of MB of a 128 MB isolate. `kv.get(..., "stream")` hands
 * back a `ReadableStream` that goes straight into the `Response`, so the bytes
 * pass through the worker without ever being resident.
 *
 * The ETag is stored as its own small key rather than derived here, so
 * answering `If-None-Match` — by far the common case, since admin polls this
 * endpoint — costs one tiny read instead of pulling 10 MB. The build writes
 * the same value into the payload's `etag` field, which is why the body can be
 * passed through verbatim instead of being re-serialised with the ETag merged
 * in.
 *
 * Returns null when this deployment has no schema in KV, so the caller falls
 * back to the in-bundle path (dev, Next.js, or a site that hasn't enabled it).
 */
async function handleMetaFromKV(request: Request): Promise<Response | null> {
  const env = getRuntimeEnv();
  if (!env) return null;

  const kv = getMetaKV(env);
  if (!kv) return null;

  const deploymentId = getDeploymentId(env);
  if (!deploymentId) return null;

  const etag = (await kv.get(metaEtagKey(deploymentId), { type: "text" })) as string | null;
  if (!etag) return null;

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const body = (await kv.get(metaKey(deploymentId), { type: "stream" })) as ReadableStream | null;
  // An ETag with no payload beside it means a half-written deployment. Fall
  // back rather than serve an empty 200 the admin would cache under that tag.
  if (!body) return null;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: etag,
      "Cache-Control": "must-revalidate",
    },
  });
}

export async function handleMeta(request: Request): Promise<Response> {
  try {
    const fromKV = await handleMetaFromKV(request);
    if (fromKV) return fromKV;
  } catch {
    // A KV blip must not take the endpoint down while the bundle still has a
    // copy — fall through to the in-bundle path below.
  }

  let metaData: MetaResponse | null;
  try {
    metaData = await loadMetaData();
  } catch {
    metaData = null;
  }
  if (!metaData) {
    return new Response(JSON.stringify({ error: "Schema not initialized" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ifNoneMatch = request.headers.get("if-none-match");
  const etag = getEtag();

  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const body = JSON.stringify({ ...metaData, etag });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: etag,
      "Cache-Control": "must-revalidate",
    },
  });
}
