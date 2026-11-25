/**
 * Regression tests: generic MasterData CRUD reachable through
 * `/deco/invoke` with the store's appKey/appToken.
 *
 * (1) configure() must mark every masterData export as serverOnly so
 *     setupApps() never registers it as an HTTP handler.
 * (2) MasterData path segments must reject traversal so a caller-controlled
 *     entity/documentId can't steer the credentialed request at another VTEX
 *     admin API (e.g. "../../api/oms/pvt/orders").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as masterData from "../actions/masterData";
import { configureVtex, setVtexFetch } from "../client";
import manifest from "../manifest.gen";
import { configure, VTEX_SERVER_ONLY } from "../mod";

function isCovered(key: string): boolean {
  return VTEX_SERVER_ONLY.some((e) => key === e || key.startsWith(`${e}/`));
}

describe("vtex configure() — serverOnly", () => {
  it("marks every masterData export as serverOnly", async () => {
    const app = await configure({ account: "store" }, async () => null);
    expect(app?.serverOnly).toEqual(VTEX_SERVER_ONLY);

    const mod = manifest.actions["vtex/actions/masterData"] as Record<string, unknown>;
    const fnKeys = Object.entries(mod)
      .filter(([, v]) => typeof v === "function")
      .map(([name]) => `vtex/actions/masterData/${name}`);
    expect(fnKeys).toContain("vtex/actions/masterData/searchDocumentsFull");
    for (const key of fnKeys) expect(isCovered(key), key).toBe(true);
  });

  it("does not mark public cart actions as serverOnly", () => {
    expect(isCovered("vtex/actions/checkout/addItemsToCart")).toBe(false);
  });
});

describe("masterData path segment validation", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(
      async () =>
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    configureVtex({ account: "store", publicUrl: "store.com", appKey: "k", appToken: "t" });
    setVtexFetch(fetchMock as unknown as typeof fetch);
  });

  afterEach(() => setVtexFetch(globalThis.fetch));

  const bad = ["../../api/oms/pvt/orders", "CL/../../x", "CL?x=1", "CL#x", "%2e%2e", "", ".."];

  it.each(bad)("searchDocumentsFull rejects acronym %j", async (acronym) => {
    await expect(masterData.searchDocumentsFull({ acronym })).rejects.toThrow(/Invalid MasterData/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(bad)("getDocument rejects documentId %j", async (documentId) => {
    await expect(masterData.getDocument({ entity: "CL", documentId })).rejects.toThrow(
      /Invalid MasterData/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-string entity", async () => {
    await expect(
      masterData.searchDocuments({ entity: { a: 1 } as unknown as string, filter: "" }),
    ).rejects.toThrow(/Invalid MasterData/);
  });

  it("still allows a valid acronym and uuid documentId", async () => {
    await masterData.searchDocumentsFull({ acronym: "NL", fields: "id", take: 1 });
    await masterData.getDocument({
      entity: "CL",
      documentId: "00000000-0000-4000-8000-000000000000",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/dataentities/NL/search");
  });
});
