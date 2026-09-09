import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMeta, setMetaProvider } from "./meta";

const G = globalThis as Record<string, unknown>;

const schema = { definitions: {}, sections: {}, loaders: {}, actions: {} } as never;

beforeEach(() => {
  G.__deco_meta_data = null;
  G.__deco_meta_etag = null;
  G.__deco_meta_provider = null;
  G.__deco_meta_loading = null;
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
