// @vitest-environment node
/**
 * The HTTP and JSON-RPC layer of createContentHandler.
 */
import { describe, expect, it, vi } from "vitest";
import { schemaFixture } from "../__tests__/fixtures";
import { readResponseJson } from "../client";
import { ErrorCode } from "../errors";
import type { ContentStorage } from "../storage";
import { StorageNotFoundError, StorageUnavailableError } from "../storage";
import { createMemoryStorage } from "../storage/memory";
import { DEFAULT_LIMITS, MAX_BATCH_CALLS } from "../types";
import { createContentHandler } from "./handler";

const URL_ = "http://test.local/rpc";
const PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----\n";

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body:
      typeof body === "string" || body instanceof Uint8Array
        ? (body as BodyInit)
        : JSON.stringify(body),
  });
}

async function call(
  handler: (r: Request) => Promise<Response>,
  body: unknown,
  headers?: Record<string, string>,
) {
  const response = await handler(post(body, headers));
  return {
    status: response.status,
    headers: response.headers,
    body: (await readResponseJson(response)) as any,
  };
}

const rpc = (id: unknown, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

const setup = (options: Parameters<typeof createContentHandler>[1] = {}) => {
  const storage = createMemoryStorage({ state: { schema: JSON.stringify(schemaFixture) } });
  return { storage, handler: createContentHandler(storage, options) };
};

describe("HTTP", () => {
  it("accepts only POST", async () => {
    const { handler } = setup();
    const response = await handler(new Request(URL_, { method: "GET" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("accepts only JSON bodies (against cross-site form posts)", async () => {
    const { handler } = setup();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const response = await handler(
        new Request(URL_, { method: "POST", headers: { "content-type": type }, body: "{}" }),
      );
      expect(response.status).toBe(415);
    }
    const ok = await call(handler, rpc(1, "describe"), {
      "content-type": "application/json; charset=utf-8",
    });
    expect(ok.status).toBe(200);
  });

  it("answers errors with HTTP 200 and a JSON-RPC error", async () => {
    const { handler } = setup();
    const response = await call(handler, rpc(1, "blocks.apply", { set: { "": {} } }));
    expect(response.status).toBe(200);
    expect(response.body.error.code).toBe(ErrorCode.InvalidBlock);
  });

  it("refuses a missing or invalid bearer token with HTTP 401", async () => {
    const { handler } = setup({ token: "s3cret" });
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer nope" },
      { authorization: "Basic s3cret" },
    ];
    for (const headers of attempts) {
      const response = await call(handler, rpc(1, "describe"), headers);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: ErrorCode.Unauthorized, message: "missing or invalid bearer token" },
      });
    }
    const ok = await call(handler, rpc(1, "describe"), { authorization: "Bearer s3cret" });
    expect(ok.status).toBe(200);
    expect(ok.body.result.protocol).toBe("deco-content");
  });

  it("checks the token before reading the body", async () => {
    const { handler } = setup({ token: "t" });
    const response = await call(handler, "{not json");
    expect(response.status).toBe(401);
  });

  it("maps authorize() outcomes: forbidden is a JSON-RPC error with HTTP 200", async () => {
    const { handler } = setup({
      authorize: (r) => (r.headers.get("x-user") === "ok" ? true : "forbidden"),
    });
    const denied = await call(handler, rpc(1, "describe"));
    expect(denied.status).toBe(200);
    expect(denied.body.error.code).toBe(ErrorCode.Forbidden);
    expect((await call(handler, rpc(1, "describe"), { "x-user": "ok" })).body.result).toBeDefined();
    const { handler: unauthorized } = setup({ authorize: () => false });
    expect((await call(unauthorized, rpc(1, "describe"))).status).toBe(401);
  });

  it("refuses a body over maxRequestBytes with HTTP 413, whatever Content-Length says", async () => {
    const { handler } = setup({ limits: { maxRequestBytes: 1024 } });
    const big = JSON.stringify(rpc(1, "blocks.apply", { set: { a: { t: "x".repeat(2000) } } }));
    const response = await call(handler, big);
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe(ErrorCode.LimitExceeded);
    // A body streamed without Content-Length is counted as it's read.
    const stream = new Blob([big]).stream();
    const streamed = await handler(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
  });

  it("decompresses gzip request bodies, and gzip can't bypass the limit", async () => {
    const { handler } = setup({ limits: { maxRequestBytes: 4096 } });
    const gzip = async (text: string) =>
      new Uint8Array(
        await new Response(
          new Blob([text]).stream().pipeThrough(new CompressionStream("gzip") as any),
        ).arrayBuffer(),
      );
    const small = await gzip(JSON.stringify(rpc(1, "describe")));
    expect((await call(handler, small, { "content-encoding": "gzip" })).body.result.protocol).toBe(
      "deco-content",
    );
    const bomb = await gzip(
      JSON.stringify(rpc(1, "blocks.apply", { set: { a: { t: "x".repeat(100_000) } } })),
    );
    expect(bomb.byteLength).toBeLessThan(4096);
    expect((await call(handler, bomb, { "content-encoding": "gzip" })).status).toBe(413);
    expect((await call(handler, "{}", { "content-encoding": "br" })).status).toBe(415);
    expect(
      (await call(handler, new Uint8Array([1, 2, 3]), { "content-encoding": "gzip" })).status,
    ).toBe(415);
  });

  it("compresses responses when the request accepts gzip", async () => {
    const { handler } = setup();
    const gz = await handler(post(rpc(1, "schema.get"), { "accept-encoding": "gzip, deflate" }));
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gz.headers.get("vary")).toBe("Accept-Encoding");
    const decoded = (await readResponseJson(gz)) as any;
    expect(decoded.result.schema).toEqual(schemaFixture);
    const plain = await handler(post(rpc(1, "schema.get")));
    expect(plain.headers.get("content-encoding")).toBeNull();
    const refused = await handler(post(rpc(1, "schema.get"), { "accept-encoding": "gzip;q=0" }));
    expect(refused.headers.get("content-encoding")).toBeNull();
  });

  it("never lets responses be cached", async () => {
    const { handler } = setup();
    const response = await handler(post(rpc(1, "describe")));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  });
});

describe("JSON-RPC envelopes", () => {
  it("rejects a request without an id rather than running it", async () => {
    const { handler, storage } = setup();
    const response = await call(handler, {
      jsonrpc: "2.0",
      method: "blocks.apply",
      params: { set: { a: {} } },
    });
    expect(response.body).toMatchObject({ id: null, error: { code: ErrorCode.InvalidRequest } });
    expect(storage.commits).toBe(0);
    const nullId = await call(handler, rpc(null, "describe"));
    expect(nullId.body.error.code).toBe(ErrorCode.InvalidRequest);
  });

  it.each([
    [
      "a wrong jsonrpc version",
      { jsonrpc: "1.0", id: 1, method: "describe" },
      ErrorCode.InvalidRequest,
    ],
    ["a non-string method", { jsonrpc: "2.0", id: 1, method: 5 }, ErrorCode.InvalidRequest],
    [
      "an extra member",
      { jsonrpc: "2.0", id: 1, method: "describe", extra: 1 },
      ErrorCode.InvalidRequest,
    ],
    ["a scalar request", 5, ErrorCode.InvalidRequest],
    ["an unknown method", rpc(1, "blocks.get", {}), ErrorCode.MethodNotFound],
    ["array params", rpc(1, "describe", []), ErrorCode.InvalidParams],
    ["unknown params", rpc(1, "describe", { x: 1 }), ErrorCode.InvalidParams],
  ])("refuses %s", async (_label, body, code) => {
    const { handler } = setup();
    expect((await call(handler, body)).body.error.code).toBe(code);
  });

  it("answers malformed JSON (and invalid UTF-8) with a Parse error", async () => {
    const { handler } = setup();
    expect((await call(handler, "{oops")).body).toMatchObject({
      id: null,
      error: { code: ErrorCode.ParseError },
    });
    expect((await call(handler, new Uint8Array([0x22, 0xff, 0x22]))).body.error.code).toBe(
      ErrorCode.ParseError,
    );
  });

  it("echoes string and number ids", async () => {
    const { handler } = setup();
    expect((await call(handler, rpc("a-1", "describe"))).body.id).toBe("a-1");
    expect((await call(handler, rpc(7, "describe"))).body.id).toBe(7);
  });
});

describe("batches", () => {
  it("run in order and return results in order", async () => {
    const { handler } = setup();
    const response = await call(handler, [
      rpc(1, "blocks.apply", { set: { a: { v: 1 } } }),
      rpc(2, "blocks.list", {}),
      rpc(3, "nope"),
      rpc(4, "blocks.apply", { delete: ["a"] }),
      rpc(5, "blocks.list", {}),
    ]);
    const items = response.body as any[];
    expect(items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
    expect(items[1].result.blocks).toEqual({ a: { v: 1 } });
    expect(items[2].error.code).toBe(ErrorCode.MethodNotFound);
    expect(items[4].result.blocks).toEqual({});
  });

  it(`hold at most ${MAX_BATCH_CALLS} calls, and an empty batch is invalid`, async () => {
    const { handler } = setup();
    const calls = (n: number) => Array.from({ length: n }, (_, i) => rpc(i, "describe"));
    expect((await call(handler, calls(MAX_BATCH_CALLS))).body).toHaveLength(MAX_BATCH_CALLS);
    expect((await call(handler, calls(MAX_BATCH_CALLS + 1))).body).toMatchObject({
      id: null,
      error: { code: ErrorCode.LimitExceeded },
    });
    expect((await call(handler, [])).body.error.code).toBe(ErrorCode.InvalidRequest);
  });

  it("aren't atomic", async () => {
    const { handler, storage } = setup();
    const items = (
      await call(handler, [
        rpc(1, "blocks.apply", { set: { kept: {} } }),
        rpc(2, "blocks.apply", { set: { "bad..name": {} } }),
      ])
    ).body as any[];
    expect(items[0].result).toBeDefined();
    expect(items[1].error.code).toBe(ErrorCode.InvalidBlock);
    expect(Object.keys(storage.dump().files)).toEqual(["kept.json"]);
  });

  it("bound the aggregate response: later reads answer LimitExceeded, writes still run", async () => {
    const { handler, storage } = setup({ limits: { maxBatchResponseBytes: 3000 } });
    storage.setFile("big.json", JSON.stringify({ t: "x".repeat(1500) }));
    const items = (
      await call(handler, [
        rpc(1, "blocks.list", {}),
        rpc(2, "blocks.list", {}),
        rpc(3, "blocks.apply", { set: { w: {} } }),
        rpc(4, "blocks.list", {}),
        rpc(5, "blocks.list", { ifNoneMatch: "stale" }),
      ])
    ).body as any[];
    expect(items[0].result.blocks.big).toBeDefined();
    expect(items[1].error.code).toBe(ErrorCode.LimitExceeded);
    expect(items[2].result.versions.w).toEqual(expect.any(String));
    expect(items[3].error.code).toBe(ErrorCode.LimitExceeded);
    expect(items[4].error.code).toBe(ErrorCode.LimitExceeded);
    expect(storage.dump().files["w.json"]).toBeDefined();
  });

  it("bound a single response too", async () => {
    const { handler, storage } = setup({ limits: { maxBatchResponseBytes: 1000 } });
    storage.setFile("big.json", JSON.stringify({ t: "x".repeat(1500) }));
    expect((await call(handler, rpc(9, "blocks.list", {}))).body).toMatchObject({
      id: 9,
      error: { code: ErrorCode.LimitExceeded },
    });
  });
});

describe("storage failures", () => {
  const failing = (error: Error): ContentStorage => ({
    ...createMemoryStorage(),
    snapshot: () => Promise.reject(error),
  });

  it("maps a missing .deco folder to NotFound", async () => {
    const handler = createContentHandler(failing(new StorageNotFoundError("no .deco folder")));
    expect((await call(handler, rpc(1, "blocks.list"))).body.error).toEqual({
      code: ErrorCode.NotFound,
      message: "no .deco folder",
    });
  });

  it("maps an unavailable storage to Unavailable with retryAfterMs", async () => {
    const handler = createContentHandler(
      failing(new StorageUnavailableError("rate limited", 1500)),
    );
    expect((await call(handler, rpc(1, "blocks.list"))).body.error).toEqual({
      code: ErrorCode.Unavailable,
      message: "rate limited",
      data: { retryAfterMs: 1500 },
    });
  });

  it("hides unexpected errors behind Internal error and reports them to onError", async () => {
    const onError = vi.fn();
    const boom = new Error("disk on fire: /secret/path");
    const handler = createContentHandler(failing(boom), { onError });
    const response = await call(handler, rpc(1, "blocks.list"));
    expect(response.body.error).toEqual({
      code: ErrorCode.InternalError,
      message: "internal error",
    });
    expect(onError).toHaveBeenCalledWith(boom);
  });
});

describe("describe", () => {
  it("reports the storage, the effective limits and the features", async () => {
    const storage = createMemoryStorage({
      state: { secretsPublicKey: PUBLIC_KEY },
      description: {
        kind: "working-tree",
        root: "apps/storefront",
        limits: { maxOpsPerApply: 100 },
      },
    });
    const handler = createContentHandler(storage, {
      server: { name: "deco-cli", version: "8.0.0" },
      limits: { maxBlockBytes: 2048, maxListBytes: DEFAULT_LIMITS.maxListBytes * 2 },
      preview: { url: "http://localhost:5173" },
    });
    const { result } = (await call(handler, rpc(1, "describe"))).body;
    expect(result).toEqual({
      protocol: "deco-content",
      version: { major: 1, minor: 0 },
      server: { name: "deco-cli", version: "8.0.0" },
      kind: "working-tree",
      readOnly: false,
      root: "apps/storefront",
      schemaFormat: "deco-meta@1",
      refs: null,
      writes: { idempotency: { retentionMs: 86_400_000 }, schemaPreconditions: true },
      pollIntervalMs: 2000,
      limits: { ...DEFAULT_LIMITS, maxOpsPerApply: 100, maxBlockBytes: 2048 },
      preview: { url: "http://localhost:5173" },
      assets: { dir: "public/assets", urlPrefix: "/assets/", maxBytes: 25 * 1024 * 1024 },
      secrets: { publicKey: PUBLIC_KEY },
    });
  });

  it.each([
    ["a private key", PUBLIC_KEY.replace(/PUBLIC/g, "PRIVATE")],
    [
      "a public key followed by a private one",
      `${PUBLIC_KEY}${PUBLIC_KEY.replace(/PUBLIC/g, "PRIVATE")}`,
    ],
    [
      "an RSA private key",
      "-----BEGIN RSA PRIVATE KEY-----\nQUJD\n-----END RSA PRIVATE KEY-----\n",
    ],
    ["two public keys", PUBLIC_KEY + PUBLIC_KEY],
    ["something that isn't PEM", "ssh-rsa AAAAB3NzaC1yc2E"],
    [
      "a file over 16 KiB",
      `-----BEGIN PUBLIC KEY-----\n${"QUJD".repeat(4200)}\n-----END PUBLIC KEY-----\n`,
    ],
  ])("never serves %s as the secrets public key", async (_label, text) => {
    const onError = vi.fn();
    const handler = createContentHandler(
      createMemoryStorage({ state: { secretsPublicKey: text } }),
      { onError },
    );
    const { result } = (await call(handler, rpc(1, "describe"))).body;
    expect(result.secrets).toBeNull();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("refuses an empty token at construction, so it can't lock every client out", () => {
    expect(() => createContentHandler(createMemoryStorage(), { token: "" })).toThrow(TypeError);
  });

  it("polls a git storage every 30 seconds by default", async () => {
    const handler = createContentHandler(createMemoryStorage({ description: { kind: "git" } }));
    expect((await call(handler, rpc(1, "describe"))).body.result.pollIntervalMs).toBe(30000);
  });

  it("reports no assets, and no secrets without a key, on a read-only endpoint", async () => {
    const handler = createContentHandler(createMemoryStorage({ description: { readOnly: true } }));
    const { result } = (await call(handler, rpc(1, "describe"))).body;
    expect(result.readOnly).toBe(true);
    expect(result.assets).toBeNull();
    expect(result.secrets).toBeNull();
  });

  it("advertises idempotency only when the storage keeps receipts", async () => {
    const storage = createMemoryStorage();
    const noReceipts: ContentStorage = { ...storage, getReceipt: undefined };
    const handler = createContentHandler(noReceipts);
    expect((await call(handler, rpc(1, "describe"))).body.result.writes.idempotency).toBeNull();
  });
});
