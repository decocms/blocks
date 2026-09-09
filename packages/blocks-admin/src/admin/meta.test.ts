import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeEnv } from "@decocms/blocks/sdk/otelAdapters";
import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { handleMeta, setMetaKVGetter, setMetaProvider } from "./meta";

const G = globalThis as Record<string, unknown>;

const schema = { definitions: {}, sections: {}, loaders: {}, actions: {} } as never;

beforeEach(() => {
  G.__deco_meta_data = null;
  G.__deco_meta_etag = null;
  G.__deco_meta_provider = null;
  G.__deco_meta_loading = null;
  setMetaKVGetter(() => null);
});

describe("lazy meta provider", () => {
  it("does not call the provider until /live/_meta is requested, then memoises it", async () => {
    const provider = vi.fn().mockResolvedValue(schema);
    setMetaProvider(provider);
    expect(provider).not.toHaveBeenCalled();

    const req = new Request("https://x/live/_meta");
    const first = await handleMeta(req);
    expect(first.status).toBe(200);
    await handleMeta(req);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("keeps the ETag stable and honours If-None-Match", async () => {
    setMetaProvider(async () => schema);
    const etag = (await handleMeta(new Request("https://x/live/_meta"))).headers.get("ETag")!;
    expect(etag).toBeTruthy();
    const res = await handleMeta(
      new Request("https://x/live/_meta", { headers: { "if-none-match": etag } }),
    );
    expect(res.status).toBe(304);
  });

  it("answers 503 on a failed load and retries on the next request", async () => {
    const provider = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(schema);
    setMetaProvider(provider);
    expect((await handleMeta(new Request("https://x/live/_meta"))).status).toBe(503);
    expect((await handleMeta(new Request("https://x/live/_meta"))).status).toBe(200);
  });

  it("answers 503 when no provider is registered", async () => {
    expect((await handleMeta(new Request("https://x/live/_meta"))).status).toBe(503);
  });
});

describe("schema served from KV (out of the isolate)", () => {
  const ETAG = '"meta-abc123"';
  const PAYLOAD = '{"definitions":{},"etag":"meta-abc123"}';

  function mockKV(store: Record<string, string>) {
    return {
      get: vi.fn(async (key: string, opts?: { type?: string }) => {
        const v = store[key];
        if (v === undefined) return null;
        if (opts?.type === "stream") {
          return new Response(v).body;
        }
        return v;
      }),
    };
  }

  function install(store: Record<string, string>) {
    const kv = mockKV(store);
    setMetaKVGetter(() => kv);
    return kv;
  }

  /** getRuntimeEnv() reads the RequestContext bag, exactly as it does in
   * workerEntry (setRuntimeEnv runs inside RequestContext.run there). */
  function withEnv<T>(request: Request, fn: () => Promise<T>): Promise<T> {
    return RequestContext.run(request, () => {
      setRuntimeEnv({ DECO_DEPLOYMENT_ID: "sha1" });
      return fn();
    });
  }

  beforeEach(() => {
    setMetaKVGetter(() => null);
  });

  it("streams the payload from KV without ever parsing it", async () => {
    const kv = install({ "meta:sha1": PAYLOAD, "meta:etag:sha1": ETAG });

    const req = new Request("https://x/live/_meta");
    const res = await withEnv(req, () => handleMeta(req));

    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(ETAG);
    expect(await res.text()).toBe(PAYLOAD);
    // The body must arrive as a stream — materialising it here would reintroduce
    // exactly the ~10 MB the KV path exists to avoid.
    expect(kv.get).toHaveBeenCalledWith("meta:sha1", { type: "stream" });
  });

  it("answers If-None-Match from the small etag key alone, never reading the payload", async () => {
    const kv = install({ "meta:sha1": PAYLOAD, "meta:etag:sha1": ETAG });

    const req = new Request("https://x/live/_meta", { headers: { "if-none-match": ETAG } });
    const res = await withEnv(req, () => handleMeta(req));

    expect(res.status).toBe(304);
    expect(kv.get).toHaveBeenCalledWith("meta:etag:sha1", { type: "text" });
    expect(kv.get).not.toHaveBeenCalledWith("meta:sha1", { type: "stream" });
  });

  it("falls back to the bundled schema when KV has no snapshot for this deployment", async () => {
    install({});
    setMetaProvider(async () => schema);

    const req = new Request("https://x/live/_meta");
    expect((await withEnv(req, () => handleMeta(req))).status).toBe(200);
  });

  it("falls back when the etag is present but the payload is missing (half-written deploy)", async () => {
    install({ "meta:etag:sha1": ETAG });
    setMetaProvider(async () => schema);

    const req = new Request("https://x/live/_meta");
    const res = await withEnv(req, () => handleMeta(req));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).not.toBe(ETAG);
  });

  it("falls back when KV throws rather than taking the endpoint down", async () => {
    setMetaKVGetter(() => ({
      get: vi.fn(async () => {
        throw new Error("kv unavailable");
      }),
    }));
    setMetaProvider(async () => schema);

    const req = new Request("https://x/live/_meta");
    expect((await withEnv(req, () => handleMeta(req))).status).toBe(200);
  });
})
