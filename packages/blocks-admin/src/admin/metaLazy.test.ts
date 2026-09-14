import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminSetup } from "../createAdminSetup";
import { handleMeta, invalidateMetaCache, setMetaData, setMetaLoader } from "./meta";

/**
 * The admin JSON Schema bundle covers every section and app, and exactly one
 * route needs it. Loading it at boot made every isolate parse it and pin the
 * composed graph on globalThis for its whole life — for traffic that never
 * touches the admin. Same shape as the decofile bug.
 *
 * These tests pin the property that matters: nothing loads the schema until a
 * request asks for it.
 */

const G = globalThis as unknown as Record<string, unknown>;

function reset() {
  G.__deco_meta_data = null;
  G.__deco_meta_etag = null;
  G.__deco_meta_loader = null;
  G.__deco_meta_loading = null;
}

const SCHEMA = { definitions: { "site/sections/Hero.tsx": { type: "object" } } };
const req = () => new Request("https://site.test/live/_meta");

beforeEach(reset);

describe("lazy admin meta schema", () => {
  it("does NOT invoke the loader at setup time", () => {
    const meta = vi.fn(() => Promise.resolve(SCHEMA));
    createAdminSetup({ meta, css: "/app.css" });
    // The whole point: boot must not touch the schema.
    expect(meta).not.toHaveBeenCalled();
  });

  it("invokes it on the first /live/_meta, once", async () => {
    const meta = vi.fn(() => Promise.resolve(SCHEMA));
    createAdminSetup({ meta, css: "/app.css" });

    const first = await handleMeta(req());
    expect(first.status).toBe(200);
    expect(meta).toHaveBeenCalledTimes(1);

    await handleMeta(req());
    expect(meta).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight load across concurrent first requests", async () => {
    let release!: (v: unknown) => void;
    const meta = vi.fn(
      () =>
        new Promise<never>((r) => {
          release = r as never;
        }),
    );
    setMetaLoader(meta as unknown as () => Promise<typeof SCHEMA>);

    const all = Promise.all([handleMeta(req()), handleMeta(req()), handleMeta(req())]);
    release(SCHEMA);
    const responses = await all;

    expect(meta).toHaveBeenCalledTimes(1);
    for (const r of responses) expect(r.status).toBe(200);
  });

  it("serves the COMPOSED schema, not the raw input", async () => {
    setMetaLoader(() => Promise.resolve(SCHEMA));
    const body = (await (await handleMeta(req())).json()) as { framework?: unknown };
    // `framework` is composeMeta's own sentinel (it is the field it sets and
    // then uses as its idempotency guard), so its presence proves the lazy
    // path still composes rather than serving the file through.
    expect(body.framework).toBeDefined();
  });

  it("retries after a failed load instead of latching a dead isolate", async () => {
    const meta = vi
      .fn<() => Promise<typeof SCHEMA>>()
      .mockRejectedValueOnce(new Error("chunk load failed"))
      .mockResolvedValueOnce(SCHEMA);
    setMetaLoader(meta);

    expect((await handleMeta(req())).status).toBe(503);
    expect((await handleMeta(req())).status).toBe(200);
    expect(meta).toHaveBeenCalledTimes(2);
  });

  it("503s when no loader and no data were ever provided", async () => {
    expect((await handleMeta(req())).status).toBe(503);
  });

  it("still honors an explicitly set schema, with no loader", async () => {
    setMetaData(SCHEMA);
    expect((await handleMeta(req())).status).toBe(200);
  });

  it("keeps explicitly-set data across invalidation — there is nothing to reload", async () => {
    // Clearing it would 503 the admin permanently for a site on setMetaData.
    setMetaData(SCHEMA);
    invalidateMetaCache();
    expect((await handleMeta(req())).status).toBe(200);
  });

  it("re-composes after invalidation when a loader can rebuild it", async () => {
    const meta = vi.fn(() => Promise.resolve(SCHEMA));
    setMetaLoader(meta);
    await handleMeta(req());
    invalidateMetaCache();
    await handleMeta(req());
    expect(meta).toHaveBeenCalledTimes(2);
  });

  it("answers 304 to a matching If-None-Match", async () => {
    setMetaLoader(() => Promise.resolve(SCHEMA));
    const etag = (await handleMeta(req())).headers.get("etag")!;
    const res = await handleMeta(
      new Request("https://site.test/live/_meta", { headers: { "if-none-match": etag } }),
    );
    expect(res.status).toBe(304);
  });
});
