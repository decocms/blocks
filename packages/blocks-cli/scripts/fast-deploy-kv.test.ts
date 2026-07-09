import { describe, expect, it, vi } from "vitest";
import {
  computeRevision,
  DEPLOYMENTS_KEY,
  LIVE_KEY,
  revisionKey,
  snapshotKey,
} from "@decocms/blocks/cms";
import { createKvRestClient, type KvRestClient, kvConfigFromEnv } from "./lib/cf-kv-rest";
import {
  buildSnapshot,
  recordAndGcDeployment,
  setLiveDeployment,
  verifySnapshotInKv,
  writeSnapshotToKv,
} from "./lib/kv-snapshot";
import {
  changedBlockFiles,
  changedBlockKeys,
  purgePathsForChangedKeys,
} from "./lib/sync-helpers";

const ID = "sha-abc123";

/** In-memory KvRestClient backed by a Map, recording put order. */
function makeClient(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const putOrder: string[] = [];
  const client: KvRestClient = {
    get: (k) => Promise.resolve(store.get(k) ?? null),
    put: (k, v) => {
      putOrder.push(k);
      store.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      store.delete(k);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve(
        [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)),
      ),
  };
  return { client, store, putOrder };
}

describe("kvConfigFromEnv", () => {
  it("reads the three CF vars", () => {
    expect(
      kvConfigFromEnv({ CF_ACCOUNT_ID: "a", CF_KV_NAMESPACE_ID: "n", CF_API_TOKEN: "t" }),
    ).toEqual({ accountId: "a", namespaceId: "n", token: "t" });
  });

  it("throws listing all missing vars", () => {
    expect(() => kvConfigFromEnv({ CF_ACCOUNT_ID: "a" })).toThrow(
      /CF_KV_NAMESPACE_ID, CF_API_TOKEN/,
    );
  });
});

describe("createKvRestClient", () => {
  const config = { accountId: "acc", namespaceId: "ns", token: "tok" };

  it("PUTs to the values endpoint with auth + body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const client = createKvRestClient({ ...config, fetchImpl });
    const key = revisionKey(ID);
    await client.put(key, "rev1");

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/accounts/acc/storage/kv/namespaces/ns/values/");
    expect(url).toContain(encodeURIComponent(key));
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.body).toBe("rev1");
  });

  it("DELETE tolerates a 404 (idempotent)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const client = createKvRestClient({ ...config, fetchImpl });
    await expect(client.delete("gone")).resolves.toBeUndefined();
  });

  it("LIST follows the pagination cursor and filters by prefix", async () => {
    const pages = [
      { result: [{ name: "decofile:a" }], result_info: { cursor: "c1" } },
      { result: [{ name: "decofile:b" }], result_info: { cursor: "" } },
    ];
    let call = 0;
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(pages[call++]), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = createKvRestClient({ ...config, fetchImpl });
    await expect(client.list("decofile:")).resolves.toEqual(["decofile:a", "decofile:b"]);

    const [url0] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url0).toContain("/keys?");
    expect(url0).toContain("prefix=decofile");
    const [url1] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(url1).toContain("cursor=c1");
  });

  it("GET returns null on 404", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const client = createKvRestClient({ ...config, fetchImpl });
    await expect(client.get("missing")).resolves.toBeNull();
  });

  it("GET returns the body text on 200", async () => {
    const fetchImpl = vi.fn(async () => new Response("hello", { status: 200 })) as unknown as typeof fetch;
    const client = createKvRestClient({ ...config, fetchImpl });
    await expect(client.get("k")).resolves.toBe("hello");
  });

  it("throws on a non-404 error status", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const client = createKvRestClient({ ...config, fetchImpl });
    await expect(client.get("k")).rejects.toThrow(/500/);
  });
});

describe("kv-snapshot helpers", () => {
  const blocks = { Site: { name: "x" }, "pages-home": { path: "/" } };

  it("buildSnapshot uses the runtime computeRevision", () => {
    const snap = buildSnapshot(blocks);
    expect(snap.revision).toBe(computeRevision(blocks));
    expect(snap.snapshot).toBe(JSON.stringify(blocks));
    expect(snap.count).toBe(2);
  });

  it("writes the keyed snapshot before revision, then verifies round-trip", async () => {
    const { client, putOrder } = makeClient();
    const snap = buildSnapshot(blocks);
    await writeSnapshotToKv(client, snap, ID);

    expect(putOrder).toEqual([snapshotKey(ID), revisionKey(ID)]);
    await expect(verifySnapshotInKv(client, snap.revision, ID)).resolves.toEqual({ ok: true });
  });

  it("verify fails when the revision mismatches", async () => {
    const { client } = makeClient({
      [snapshotKey(ID)]: "{}",
      [revisionKey(ID)]: "other",
    });
    const res = await verifySnapshotInKv(client, "expected", ID);
    expect(res.ok).toBe(false);
  });

  it("setLiveDeployment writes index:live", async () => {
    const { client, store } = makeClient();
    await setLiveDeployment(client, ID);
    expect(store.get(LIVE_KEY)).toBe(ID);
  });
});

describe("recordAndGcDeployment", () => {
  it("appends to index:deployments (newest last, deduped)", async () => {
    const { client, store } = makeClient({
      [DEPLOYMENTS_KEY]: JSON.stringify([{ id: "old", ts: 1 }]),
    });
    await recordAndGcDeployment(client, "new", 2, 10);
    expect(JSON.parse(store.get(DEPLOYMENTS_KEY)!)).toEqual([
      { id: "old", ts: 1 },
      { id: "new", ts: 2 },
    ]);
  });

  it("re-recording an existing id moves it to newest without duplicating", async () => {
    const { client, store } = makeClient({
      [DEPLOYMENTS_KEY]: JSON.stringify([
        { id: "a", ts: 1 },
        { id: "b", ts: 2 },
      ]),
    });
    await recordAndGcDeployment(client, "a", 3, 10);
    expect(JSON.parse(store.get(DEPLOYMENTS_KEY)!)).toEqual([
      { id: "b", ts: 2 },
      { id: "a", ts: 3 },
    ]);
  });

  it("prunes snapshots beyond the retain window", async () => {
    const entries = [
      { id: "d1", ts: 1 },
      { id: "d2", ts: 2 },
    ];
    const initial: Record<string, string> = { [DEPLOYMENTS_KEY]: JSON.stringify(entries) };
    for (const e of entries) {
      initial[snapshotKey(e.id)] = "{}";
      initial[revisionKey(e.id)] = "r";
    }
    const { client, store } = makeClient(initial);

    // retain=2 → adding d3 evicts the oldest (d1).
    const { pruned } = await recordAndGcDeployment(client, "d3", 3, 2);
    expect(pruned).toEqual(["d1"]);
    expect(store.has(snapshotKey("d1"))).toBe(false);
    expect(store.has(revisionKey("d1"))).toBe(false);
    expect(store.has(snapshotKey("d2"))).toBe(true);
    expect(JSON.parse(store.get(DEPLOYMENTS_KEY)!).map((e: { id: string }) => e.id)).toEqual([
      "d2",
      "d3",
    ]);
  });

  it("never prunes the currently-live deployment even if it is old", async () => {
    const entries = [
      { id: "d1", ts: 1 },
      { id: "d2", ts: 2 },
    ];
    const initial: Record<string, string> = {
      [DEPLOYMENTS_KEY]: JSON.stringify(entries),
      [LIVE_KEY]: "d1", // live points at the oldest
    };
    for (const e of entries) {
      initial[snapshotKey(e.id)] = "{}";
      initial[revisionKey(e.id)] = "r";
    }
    const { client, store } = makeClient(initial);

    const { pruned } = await recordAndGcDeployment(client, "d3", 3, 2);
    expect(pruned).toEqual([]); // d1 would be evicted but it's live → kept
    expect(store.has(snapshotKey("d1"))).toBe(true);
    expect(JSON.parse(store.get(DEPLOYMENTS_KEY)!).map((e: { id: string }) => e.id)).toEqual([
      "d1",
      "d2",
      "d3",
    ]);
  });
});

describe("sync-helpers", () => {
  it("changedBlockFiles filters to the blocks dir and .json", () => {
    const out = [
      ".deco/blocks/pages-home.json",
      ".deco/blocks/Site.json",
      "src/components/Foo.tsx",
      "README.md",
      ".deco/blocks/notjson.txt",
    ].join("\n");
    expect(changedBlockFiles(out, ".deco/blocks")).toEqual([
      ".deco/blocks/pages-home.json",
      ".deco/blocks/Site.json",
    ]);
  });

  it("changedBlockKeys decodes URL-encoded filenames", () => {
    expect(changedBlockKeys([".deco/blocks/pages-Home%20-%20LB-1.json"])).toEqual([
      "pages-Home - LB-1",
    ]);
  });

  it("purgePathsForChangedKeys collects page paths + always '/'", () => {
    const blocks = {
      "pages-home": { path: "/" },
      "pages-pdp": { path: "/produto/:slug/p" },
      Site: { name: "x" }, // no path
    };
    const paths = purgePathsForChangedKeys(blocks, ["pages-pdp", "Site"]);
    expect(paths).toContain("/");
    expect(paths).toContain("/produto/:slug/p");
    expect(paths).not.toContain(undefined);
  });
});
