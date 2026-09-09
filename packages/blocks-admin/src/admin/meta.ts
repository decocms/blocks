import { djb2Hex } from "@decocms/blocks/sdk/djb2";
import { composeMeta, type MetaResponse } from "@decocms/blocks/cms";

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

export async function handleMeta(request: Request): Promise<Response> {
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
