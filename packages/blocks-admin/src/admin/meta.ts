import { djb2Hex } from "@decocms/blocks/sdk/djb2";
import { composeMeta, type MetaResponse } from "@decocms/blocks/cms";

// Use globalThis to share meta state across module instances.
// The daemon middleware imports this module via native import() (outside Vite SSR),
// while setup.ts calls setMetaData() via Vite SSR — these are different module instances.
// globalThis bridges them so both see the same metaData.
const G = globalThis as unknown as {
  __deco_meta_data?: MetaResponse | null;
  __deco_meta_etag?: string | null;
  __deco_meta_loader?: (() => Promise<MetaResponse>) | null;
  __deco_meta_loading?: Promise<MetaResponse | null> | null;
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
  // Drop the composed schema too, but ONLY when it can be rebuilt. With a
  // loader registered the next request re-imports and re-composes (composeMeta
  // injects page schemas over the current blocks, so a decofile change really
  // does invalidate it). With data set explicitly via `setMetaData` there is
  // nothing to reload — clearing it would 503 the admin permanently.
  if (G.__deco_meta_loader) setMetaDataInternal(null);
}

/**
 * Register the schema loader instead of resolving it now.
 *
 * The schema is a JSON Schema bundle covering every section and app, and it is
 * needed by exactly one route: `/live/_meta`. Loading it at boot meant every
 * isolate parsed it and pinned the composed graph on `globalThis` for its whole
 * life — for traffic that never touches the admin. Same shape as the decofile
 * bug: a large JSON graph permanently reachable from a module-level binding.
 *
 * `createAdminSetup` has always documented this as lazy; it just wasn't.
 */
export function setMetaLoader(loader: () => Promise<MetaResponse>) {
  G.__deco_meta_loader = loader;
}

/**
 * The composed schema, importing + composing it on first use.
 *
 * Concurrent first requests share one in-flight load. A failed load is NOT
 * latched: the rejection is swallowed to `null` (the caller answers 503) and
 * the next request retries, so a transient import failure can't disable the
 * admin for the isolate's life.
 */
async function ensureMetaData(): Promise<MetaResponse | null> {
  const existing = getMetaData();
  if (existing) return existing;

  const loader = G.__deco_meta_loader;
  if (!loader) return null;

  G.__deco_meta_loading ??= loader()
    .then((data) => {
      const composed = composeMeta(data);
      setMetaDataInternal(composed);
      setCachedEtag(null);
      return composed;
    })
    .catch((err) => {
      console.warn("[deco] admin meta schema failed to load:", err);
      return null;
    })
    .finally(() => {
      G.__deco_meta_loading = null;
    });

  return G.__deco_meta_loading;
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
  const metaData = await ensureMetaData();
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
