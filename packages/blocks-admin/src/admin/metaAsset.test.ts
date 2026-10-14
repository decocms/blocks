import type { MetaResponse } from "@decocms/blocks/cms";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMeta, setMetaAssetFetcher, setMetaLoader } from "./meta";

/**
 * With `decoVitePlugin({ metaAsset: true })` the server bundle's meta.gen is a
 * `{ __decoMetaAsset: { path, etag } }` marker and the schema lives in a static
 * asset. handleMeta must serve those bytes without ever holding them, and must
 * never "compose" the marker as if it were a schema.
 */

const G = globalThis as unknown as Record<string, unknown>;
const ETAG = '"meta-0123456789abcdef"';
const MARKER = { __decoMetaAsset: { path: "/_deco/meta-0123456789abcdef.json", etag: ETAG } };
const BODY = `{"major":1,"etag":${JSON.stringify(ETAG)}}`;
const req = (headers?: HeadersInit) => new Request("https://site.test/live/_meta", { headers });

beforeEach(() => {
  for (const k of ["data", "etag", "loader", "loading", "asset", "asset_fetcher"])
    G[`__deco_meta_${k}`] = null;
});

function useMarker() {
  const loader = vi.fn(() => Promise.resolve(MARKER as unknown as MetaResponse));
  setMetaLoader(loader);
  return loader;
}

describe("admin meta schema served from a static asset", () => {
  it("streams the asset body with the precomputed ETag", async () => {
    useMarker();
    const fetcher = vi.fn(() => new Response(BODY));
    setMetaAssetFetcher(fetcher);

    const res = await handleMeta(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(ETAG);
    expect(await res.text()).toBe(BODY);
    expect(fetcher).toHaveBeenCalledWith(MARKER.__decoMetaAsset.path);
  });

  it("answers If-None-Match without touching the asset", async () => {
    useMarker();
    const fetcher = vi.fn(() => new Response(BODY));
    setMetaAssetFetcher(fetcher);

    const res = await handleMeta(req({ "If-None-Match": ETAG }));
    expect(res.status).toBe(304);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resolves the marker once, and never composes it into a schema", async () => {
    const loader = useMarker();
    setMetaAssetFetcher(() => new Response(BODY));
    await handleMeta(req());
    await handleMeta(req());
    expect(loader).toHaveBeenCalledTimes(1);
    expect(G.__deco_meta_data).toBeNull();
  });

  it("answers 503 — not a degenerate 200 — when the asset can't be read", async () => {
    useMarker();
    expect((await handleMeta(req())).status).toBe(503); // no fetcher registered

    setMetaAssetFetcher(() => null); // no ASSETS binding
    expect((await handleMeta(req())).status).toBe(503);

    setMetaAssetFetcher(() => new Response("not found", { status: 404 }));
    expect((await handleMeta(req())).status).toBe(503);

    setMetaAssetFetcher(() => Promise.reject(new Error("binding blew up")));
    expect((await handleMeta(req())).status).toBe(503);
  });
});
