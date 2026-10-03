// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createContentClient } from "./client";
import { ContentProtocolError, ErrorCode } from "./errors";
import { createContentHandler } from "./server";
import { createMemoryStorage } from "./storage/memory";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createContentClient", () => {
  it("posts JSON-RPC 2.0 with the bearer token and extra headers", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("http://h/rpc");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.headers.get("authorization")).toBe("Bearer t0k");
      expect(request.headers.get("x-project")).toBe("p");
      const body = await request.json();
      expect(body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "blocks.list",
        params: { ifNoneMatch: "r" },
      });
      return json({
        jsonrpc: "2.0",
        id: 1,
        result: { notModified: true, revision: "r", resolvedRef: null },
      });
    });
    const client = createContentClient({
      endpoint: "http://h/rpc",
      token: "t0k",
      headers: { "x-project": "p" },
      fetch,
    });
    expect(await client.blocksList({ ifNoneMatch: "r" })).toEqual({
      notModified: true,
      revision: "r",
      resolvedRef: null,
    });
  });

  it("throws ContentProtocolError with the code, message and data", async () => {
    const client = createContentClient({
      endpoint: "http://h/rpc",
      fetch: async () =>
        json({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: ErrorCode.Conflict,
            message: "a precondition failed",
            data: { entries: {} },
          },
        }),
    });
    const error = await client.blocksApply({ set: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ContentProtocolError);
    expect(error).toMatchObject({
      code: ErrorCode.Conflict,
      message: "a precondition failed",
      data: { entries: {} },
    });
  });

  it("throws the whole-request error of a 401 or 413", async () => {
    for (const [status, code] of [
      [401, ErrorCode.Unauthorized],
      [413, ErrorCode.LimitExceeded],
    ] as const) {
      const client = createContentClient({
        endpoint: "http://h/rpc",
        fetch: async () =>
          json({ jsonrpc: "2.0", id: null, error: { code, message: "x" } }, status),
      });
      await expect(client.describe()).rejects.toMatchObject({ code });
    }
  });

  it("reports a non-JSON answer as Unavailable", async () => {
    const client = createContentClient({
      endpoint: "http://h/rpc",
      fetch: async () => new Response("<html>", { status: 502 }),
    });
    await expect(client.describe()).rejects.toMatchObject({ code: ErrorCode.Unavailable });
  });

  it("batches calls in one request and returns outcomes in order", async () => {
    const storage = createMemoryStorage();
    const handler = vi.fn(createContentHandler(storage));
    const client = createContentClient({ endpoint: "http://h/rpc", fetch: handler });
    const outcomes = await client.batch([
      { method: "blocks.apply", params: { set: { a: {} } } },
      { method: "blocks.apply", params: { set: { "": {} } } },
      { method: "describe" },
    ]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(!outcomes[1].ok && outcomes[1].error.code).toBe(ErrorCode.InvalidBlock);
  });

  it("decodes gzip bodies a custom fetch hands back undecoded", async () => {
    const storage = createMemoryStorage({
      state: { schema: JSON.stringify({ pad: "x".repeat(5000) }) },
    });
    const handler = createContentHandler(storage);
    const client = createContentClient({
      endpoint: "http://h/rpc",
      fetch: (request) => {
        const headers = new Headers(request.headers);
        headers.set("accept-encoding", "gzip");
        return handler(new Request(request, { headers }));
      },
    });
    const result = await client.schemaGet();
    expect(!result.notModified && result.schema).toEqual({ pad: "x".repeat(5000) });
  });
});

describe("protocol versions", () => {
  const describing = (result: unknown) =>
    createContentClient({
      endpoint: "http://h/rpc",
      fetch: async () => json({ jsonrpc: "2.0", id: 1, result }),
    });

  it("accepts any minor of the major it speaks", async () => {
    const result = { protocol: "deco-content", version: { major: 1, minor: 7 } };
    expect(await describing(result).describe()).toEqual(result);
  });

  it.each([
    ["an unknown major", { protocol: "deco-content", version: { major: 2, minor: 0 } }],
    ["an older major", { protocol: "deco-content", version: { major: 0, minor: 9 } }],
    ["another protocol", { protocol: "other", version: { major: 1, minor: 0 } }],
    ["no version", { protocol: "deco-content" }],
    ["a non-object result", null],
  ])("refuses %s with Unsupported", async (_label, result) => {
    const error = await describing(result)
      .describe()
      .catch((e) => e);
    expect(error).toBeInstanceOf(ContentProtocolError);
    expect(error.code).toBe(ErrorCode.Unsupported);
  });

  it("speaks to the server in this package", async () => {
    const client = createContentClient({
      endpoint: "http://h/rpc",
      fetch: createContentHandler(createMemoryStorage()),
    });
    expect((await client.describe()).version.major).toBe(1);
  });
});
