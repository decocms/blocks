import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeRevision, KV_KEYS } from "../src/cms/blockSource";
import { createKvRestClient, kvConfigFromEnv } from "./lib/cf-kv-rest";
import { kvNamespaceIdFromToml, kvNamespaceIdFromWrangler } from "./lib/wrangler-config";
import { buildSnapshot, verifySnapshotInKv, writeSnapshotToKv } from "./lib/kv-snapshot";
import {
  changedBlockFiles,
  changedBlockKeys,
  purgePathsForChangedKeys,
} from "./lib/sync-helpers";

describe("kvConfigFromEnv", () => {
  it("reads the three CF vars", () => {
    expect(
      kvConfigFromEnv({ CF_ACCOUNT_ID: "a", CF_KV_NAMESPACE_ID: "n", CF_API_TOKEN: "t" }),
    ).toEqual({ accountId: "a", namespaceId: "n", token: "t" });
  });

  it("falls back to wrangler's standard CLOUDFLARE_* vars (CF Workers Builds)", () => {
    expect(
      kvConfigFromEnv({
        CLOUDFLARE_ACCOUNT_ID: "a",
        CF_KV_NAMESPACE_ID: "n",
        CLOUDFLARE_API_TOKEN: "t",
      }),
    ).toEqual({ accountId: "a", namespaceId: "n", token: "t" });
  });

  it("explicit CF_* wins over CLOUDFLARE_* fallbacks", () => {
    expect(
      kvConfigFromEnv({
        CF_ACCOUNT_ID: "explicit",
        CLOUDFLARE_ACCOUNT_ID: "fallback",
        CF_KV_NAMESPACE_ID: "n",
        CF_API_TOKEN: "explicit-tok",
        CLOUDFLARE_API_TOKEN: "fallback-tok",
      }),
    ).toEqual({ accountId: "explicit", namespaceId: "n", token: "explicit-tok" });
  });

  it("throws listing all missing vars (with fallback hints)", () => {
    expect(() => kvConfigFromEnv({ CF_ACCOUNT_ID: "a" })).toThrow(
      /CF_KV_NAMESPACE_ID \(or a DECO_KV binding in wrangler config\), CF_API_TOKEN \(or CLOUDFLARE_API_TOKEN\)/,
    );
  });
});

describe("kvNamespaceIdFromToml", () => {
  it("finds the id of the DECO_KV binding among multiple tables", () => {
    const toml = [
      `[[kv_namespaces]]`,
      `binding = "OTHER"`,
      `id = "wrong"`,
      ``,
      `[[kv_namespaces]]`,
      `binding = "DECO_KV"`,
      `id = "right-id"`,
      ``,
      `[vars]`,
      `DECO_FAST_DEPLOY = "1"`,
    ].join("\n");
    expect(kvNamespaceIdFromToml(toml, "DECO_KV")).toBe("right-id");
  });

  it("returns null when the binding is absent", () => {
    expect(kvNamespaceIdFromToml(`[[kv_namespaces]]\nbinding = "X"\nid = "y"`, "DECO_KV")).toBeNull();
  });
});

describe("kvNamespaceIdFromWrangler (jsonc)", () => {
  it("reads the DECO_KV binding id from wrangler.jsonc", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrangler-test-"));
    try {
      fs.writeFileSync(
        path.join(dir, "wrangler.jsonc"),
        `{
          // site worker config
          "kv_namespaces": [
            { "binding": "DECO_KV", "id": "jsonc-id" },
          ],
        }`,
      );
      expect(kvNamespaceIdFromWrangler(dir)).toBe("jsonc-id");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no wrangler config exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrangler-test-"));
    try {
      expect(kvNamespaceIdFromWrangler(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createKvRestClient", () => {
  const config = { accountId: "acc", namespaceId: "ns", token: "tok" };

  it("PUTs to the values endpoint with auth + body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const client = createKvRestClient({ ...config, fetchImpl });
    await client.put(KV_KEYS.REVISION, "rev1");

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/accounts/acc/storage/kv/namespaces/ns/values/");
    expect(url).toContain(encodeURIComponent(KV_KEYS.REVISION));
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.body).toBe("rev1");
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

  it("writes snapshot before revision, then verifies round-trip", async () => {
    const store = new Map<string, string>();
    const order: string[] = [];
    const client = {
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      put: (k: string, v: string) => {
        order.push(k);
        store.set(k, v);
        return Promise.resolve();
      },
    };
    const snap = buildSnapshot(blocks);
    await writeSnapshotToKv(client, snap);

    expect(order).toEqual([KV_KEYS.SNAPSHOT, KV_KEYS.REVISION]);
    await expect(verifySnapshotInKv(client, snap.revision)).resolves.toEqual({ ok: true });
  });

  it("verify fails when the revision mismatches", async () => {
    const store = new Map<string, string>([
      [KV_KEYS.SNAPSHOT, "{}"],
      [KV_KEYS.REVISION, "other"],
    ]);
    const client = { get: (k: string) => Promise.resolve(store.get(k) ?? null), put: () => Promise.resolve() };
    const res = await verifySnapshotInKv(client, "expected");
    expect(res.ok).toBe(false);
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
