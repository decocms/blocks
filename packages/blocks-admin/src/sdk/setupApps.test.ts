// @vitest-environment node
/**
 * Regression tests for setupApps() `serverOnly` filtering.
 *
 * The historical bug: setupApps() registered EVERY function exported by an
 * app manifest as a `/deco/invoke` handler and a CMS-resolvable
 * `__resolveType`. For VTEX that included generic MasterData CRUD
 * (`vtex/actions/masterData/searchDocumentsFull`, …), which runs with the
 * store's appKey/appToken on caller-supplied entity/fields/where — so an
 * anonymous POST to /deco/invoke read customer (CL) records.
 *
 * These tests pin the fix: keys an app lists in `serverOnly` must be
 * unreachable over both HTTP paths, while every other export keeps working.
 */

import { clearCommerceLoaders, resolveValue } from "@decocms/blocks/cms";
import { afterEach, describe, expect, it } from "vitest";
import { clearInvokeHandlers, handleInvoke } from "../admin/invoke";
import { type AppDefinition, isServerOnlyKey, setupApps } from "./setupApps";

function makeApp(serverOnly?: string[]): AppDefinition {
  return {
    name: "fake",
    state: {},
    serverOnly,
    manifest: {
      name: "fake",
      loaders: {},
      actions: {
        "fake/actions/masterData": {
          searchDocumentsFull: async () => [{ email: "leak@example.com" }],
          createDocument: async () => ({ DocumentId: "x" }),
        },
        "fake/actions/checkout": {
          addItemsToCart: async () => ({ ok: true }),
        },
      },
    },
  };
}

/**
 * Resolve a caller-supplied `__resolveType` the way /deco/render resolves
 * section props. Returns whatever the CMS resolver produced (a loader result
 * when the key is registered).
 */
async function resolvesTo(resolveType: string): Promise<string> {
  const out = await resolveValue({ x: { __resolveType: resolveType } });
  return JSON.stringify(out ?? null);
}

function invoke(key: string): Promise<Response> {
  return handleInvoke(
    new Request(`http://localhost/deco/invoke/${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acronym: "CL", fields: "email", take: 1 }),
    }),
  );
}

function batch(body: Record<string, unknown>): Promise<Response> {
  return handleInvoke(
    new Request("http://localhost/deco/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("setupApps — serverOnly", () => {
  afterEach(() => {
    clearInvokeHandlers();
    clearCommerceLoaders();
  });

  it("does not expose serverOnly exports via /deco/invoke (with or without .ts)", async () => {
    await setupApps([makeApp(["fake/actions/masterData"])]);

    for (const key of [
      "fake/actions/masterData/searchDocumentsFull",
      "fake/actions/masterData/searchDocumentsFull.ts",
      "fake/actions/masterData/createDocument",
    ]) {
      const res = await invoke(key);
      expect(res.status, key).toBe(404);
      expect(await res.text()).not.toContain("leak@example.com");
    }
  });

  it("does not expose serverOnly exports via batch invoke __resolveType", async () => {
    await setupApps([makeApp(["fake/actions/masterData"])]);

    const res = await batch({
      a: { __resolveType: "fake/actions/masterData/searchDocumentsFull" },
    });
    const body = await res.text();
    expect(body).not.toContain("leak@example.com");
    expect(body).toContain("Unknown handler");
  });

  it("does not register serverOnly exports in the CMS resolver map", async () => {
    await setupApps([makeApp(["fake/actions/masterData"])]);

    for (const key of [
      "fake/actions/masterData/searchDocumentsFull",
      "fake/actions/masterData/searchDocumentsFull.ts",
    ]) {
      expect(await resolvesTo(key), key).not.toContain("leak@example.com");
    }
  });

  it("filters explicit app handlers too", async () => {
    const app = {
      ...makeApp(["fake/actions/masterData"]),
      handlers: {
        "fake/actions/masterData/searchDocuments": async () => [{ email: "leak@example.com" }],
      },
    };
    await setupApps([app]);

    expect((await invoke("fake/actions/masterData/searchDocuments")).status).toBe(404);
    expect(await resolvesTo("fake/actions/masterData/searchDocuments")).not.toContain(
      "leak@example.com",
    );
  });

  it("keeps non-serverOnly exports reachable", async () => {
    await setupApps([makeApp(["fake/actions/masterData"])]);

    const res = await invoke("fake/actions/checkout/addItemsToCart");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await resolvesTo("fake/actions/checkout/addItemsToCart")).toContain('"ok":true');
  });

  it("registers everything when serverOnly is absent (backward compat)", async () => {
    await setupApps([makeApp()]);
    expect((await invoke("fake/actions/masterData/createDocument")).status).toBe(200);
    expect(await resolvesTo("fake/actions/masterData/searchDocumentsFull")).toContain(
      "leak@example.com",
    );
  });
});

describe("isServerOnlyKey", () => {
  const list = ["vtex/actions/masterData"];

  it("matches the module key, its functions and .ts/.tsx aliases", () => {
    expect(isServerOnlyKey("vtex/actions/masterData", list)).toBe(true);
    expect(isServerOnlyKey("vtex/actions/masterData.ts", list)).toBe(true);
    expect(isServerOnlyKey("vtex/actions/masterData/searchDocumentsFull", list)).toBe(true);
    expect(isServerOnlyKey("vtex/actions/masterData/getDocument.tsx", list)).toBe(true);
  });

  it("does not match sibling modules that share a name prefix", () => {
    expect(isServerOnlyKey("vtex/actions/masterDataPublic/subscribe", list)).toBe(false);
    expect(isServerOnlyKey("vtex/actions/checkout/addItemsToCart", list)).toBe(false);
  });
});
