import { createCMS, resetForTests, type Snapshot } from "@decocms/blocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kvLoader } from "./kvLoader";

const snapshot: Snapshot = {
  revision: "r1",
  blocks: { Hello: { __resolveType: "greeting", name: "world" } },
};

function kv(values: Record<string, unknown>) {
  return { get: vi.fn(async (key: string, _type: "json") => values[key] ?? null) };
}

afterEach(() => resetForTests());

describe("kvLoader", () => {
  it("reads the snapshot under its key once per isolate", async () => {
    const namespace = kv({ "decofile:abc": snapshot });
    const loader = kvLoader(namespace, { key: "decofile:abc" });
    expect(await loader.load()).toEqual(snapshot);
    expect(await loader.load("api.deco.example/drafts/x@v1")).toEqual(snapshot);
    expect(namespace.get).toHaveBeenCalledTimes(1);
    expect(namespace.get).toHaveBeenCalledWith("decofile:abc", "json");
    expect(loader.update).toBeUndefined();
  });

  it("shares one in-flight read between concurrent loads", async () => {
    let release!: (value: unknown) => void;
    const namespace = { get: vi.fn(() => new Promise((resolve) => (release = resolve))) };
    const loader = kvLoader(namespace, { key: "content" });
    const first = loader.load();
    const second = loader.load();
    release(snapshot);
    expect(await first).toEqual(snapshot);
    expect(await second).toEqual(snapshot);
    expect(namespace.get).toHaveBeenCalledTimes(1);
  });

  it("fails on a missing key and reads KV again on the next call", async () => {
    const values: Record<string, unknown> = {};
    const namespace = kv(values);
    const loader = kvLoader(namespace, { key: "decofile:abc" });
    await expect(loader.load()).rejects.toThrow(/decofile:abc/);
    values["decofile:abc"] = snapshot;
    expect(await loader.load()).toEqual(snapshot);
    expect(namespace.get).toHaveBeenCalledTimes(2);
  });

  it("serves a CMS without reading KV per request", async () => {
    const namespace = kv({ content: snapshot });
    const cms = createCMS({
      blocks: { greeting: (input: { name: string }) => `Hello, ${input.name}` },
      content: kvLoader(namespace, { key: "content" }),
    });
    expect(await cms.forRelease().resolve("Hello")).toEqual(["Hello, world", null]);
    expect(await cms.forRelease().resolve("Hello")).toEqual(["Hello, world", null]);
    expect(namespace.get).toHaveBeenCalledTimes(1);
  });

  it("surfaces a missing key as LOADER_FAILED", async () => {
    const cms = createCMS({ blocks: {}, content: kvLoader(kv({}), { key: "content" }) });
    const [, error] = await cms.forRelease().list("page");
    expect(error?.code).toBe("LOADER_FAILED");
  });

  it("surfaces a value that isn't a snapshot as LOADER_FAILED", async () => {
    const cms = createCMS({
      blocks: {},
      content: kvLoader(kv({ content: {} }), { key: "content" }),
    });
    const [, error] = await cms.forRelease().list("page");
    expect(error?.code).toBe("LOADER_FAILED");
  });
});
