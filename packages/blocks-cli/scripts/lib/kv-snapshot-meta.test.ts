import { describe, expect, it, vi } from "vitest";
import { writeMetaToKv } from "./kv-snapshot";

function fakeClient() {
  const puts: Record<string, string> = {};
  return {
    puts,
    client: {
      get: vi.fn(),
      put: vi.fn(async (k: string, v: string) => {
        puts[k] = v;
      }),
      delete: vi.fn(),
      list: vi.fn(),
    } as never,
  };
}

describe("writeMetaToKv", () => {
  it("merges the etag into the payload so the read path can stream bytes verbatim", async () => {
    const { client, puts } = fakeClient();

    const etag = await writeMetaToKv(client, '{"definitions":{"A":{}}}', "sha1");

    // The stored payload must parse to the schema PLUS an etag field holding
    // the SAME quoted value the ETag header carries — that mirrors the existing
    // wire format (`{...metaData, etag}`, where etag is already `"meta-xxx"`)
    // and is what lets handleMeta skip re-serialising 10 MB of JSON.
    expect(etag).toMatch(/^"meta-[a-z0-9]+"$/);
    expect(JSON.parse(puts["meta:sha1"])).toEqual({ definitions: { A: {} }, etag });
    expect(puts["meta:etag:sha1"]).toBe(etag);
  });

  it("writes the payload before the etag key", async () => {
    const { client } = fakeClient();
    await writeMetaToKv(client, '{"a":1}', "sha1");
    const order = (client as unknown as { put: { mock: { calls: string[][] } } }).put.mock.calls.map(
      (c) => c[0],
    );
    // A reader that saw a fresh etag beside a stale payload would cache the
    // wrong bytes under the new tag.
    expect(order).toEqual(["meta:sha1", "meta:etag:sha1"]);
  });

  it("produces a different etag when the schema changes", async () => {
    const { client } = fakeClient();
    const a = await writeMetaToKv(client, '{"a":1}', "sha1");
    const b = await writeMetaToKv(client, '{"a":2}', "sha1");
    expect(a).not.toBe(b);
  });

  it("handles an empty object without emitting invalid JSON", async () => {
    const { client, puts } = fakeClient();
    await writeMetaToKv(client, "{}", "sha1");
    expect(() => JSON.parse(puts["meta:sha1"])).not.toThrow();
  });

  it("refuses anything that is not a JSON object", async () => {
    const { client } = fakeClient();
    await expect(writeMetaToKv(client, "[1,2,3]", "sha1")).rejects.toThrow(/not a JSON object/);
  });
});
