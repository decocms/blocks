// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createContentClient } from "./client";
import { ContentProtocolError, ErrorCode } from "./errors";
import { createContentHandler } from "./server";
import { createMemoryStorage } from "./storage/memory";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createContentClient", () => {
  it("posts JSON-RPC 2.0 with the extra headers", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("http://h/rpc");
      expect(request.headers.get("content-type")).toBe("application/json");
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

  it("throws the whole-request error of a 401 (from the host's own auth) or 413", async () => {
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

  it("accepts any minor from the one it needs (1.1) on", async () => {
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

  it("refuses a 1.0 server (8.1.x deco serve) as outdated, saying to update it", async () => {
    const error = await describing({
      protocol: "deco-content",
      version: { major: 1, minor: 0 },
      server: { name: "deco-cli", version: "8.1.1" },
    })
      .describe()
      .catch((e) => e);
    expect(error).toBeInstanceOf(ContentProtocolError);
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.message).toMatch(/update @decocms\/blocks.*8\.2\.0.*deco serve/);
    expect(error.data).toEqual({
      reason: "outdated",
      required: { major: 1, minor: 1 },
      actual: { protocol: "deco-content", major: 1, minor: 0 },
      server: { name: "deco-cli", version: "8.1.1" },
    });
  });

  it.each([
    ["an unknown major", { protocol: "deco-content", version: { major: 2, minor: 0 } }, "major"],
    ["another protocol", { protocol: "other", version: { major: 1, minor: 1 } }, "protocol"],
  ])("tells %s apart in data.reason", async (_label, result, reason) => {
    const error = await describing(result)
      .describe()
      .catch((e) => e);
    expect(error.data.reason).toBe(reason);
  });

  it("turns Method not found on changes.* into the outdated Unsupported, in calls and batches", async () => {
    const client = createContentClient({
      endpoint: "http://h/rpc",
      fetch: async (request) => {
        const body = await request.json();
        const answer = (r: { id: number; method: string }) => ({
          jsonrpc: "2.0",
          id: r.id,
          error: { code: ErrorCode.MethodNotFound, message: `unknown method "${r.method}"` },
        });
        return json(Array.isArray(body) ? body.map(answer) : answer(body));
      },
    });
    const error = await client.changesList().catch((e) => e);
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.data.reason).toBe("outdated");
    const [changes, blocks] = await client.batch([
      { method: "changes.get", params: { names: ["a"] } },
      { method: "blocks.list" },
    ]);
    expect(!changes!.ok && changes!.error.code).toBe(ErrorCode.Unsupported);
    expect(!blocks!.ok && blocks!.error.code).toBe(ErrorCode.MethodNotFound);
  });

  it("speaks to the server in this package", async () => {
    const client = createContentClient({
      endpoint: "http://h/rpc",
      fetch: createContentHandler(createMemoryStorage()),
    });
    expect((await client.describe()).version.major).toBe(1);
  });
});
