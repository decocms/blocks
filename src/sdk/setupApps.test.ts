// @vitest-environment node
//
// setupApps() early-returns when `document` is defined (it is server-only),
// so this suite must run without a DOM or every registration is skipped.
/**
 * Integration test for the runtime exposure door (Machine 2).
 *
 * setupApps() flattens an app's manifest into the invoke handler registry.
 * The regression we lock here: generic MasterData CRUD actions
 * (searchDocuments/createDocument/…) must NOT be registered, so
 * `POST /deco/invoke/vtex/actions/masterData/searchDocuments` returns 404 —
 * while ordinary actions (cart) still resolve. This is the sibling of the
 * build-time _serverFn denial exercised in generate-invoke.test.ts; both
 * consult the same invokePolicy so they can't drift.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { clearInvokeHandlers, handleInvoke } from "../admin/invoke";
import { setupApps } from "./setupApps";

function invokeReq(key: string): Request {
  return new Request(`https://site.example/deco/invoke/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

// A fake VTEX-shaped app whose manifest exposes both a safe cart action and
// the dangerous MasterData CRUD actions as named exports.
function fakeVtexApp() {
  return {
    name: "vtex",
    state: {},
    manifest: {
      name: "vtex",
      loaders: {},
      actions: {
        "vtex/actions/checkout": {
          getOrCreateCart: async () => ({ ok: "cart" }),
        },
        "vtex/actions/masterData": {
          searchDocuments: async () => ({ leaked: "PII" }),
          createDocument: async () => ({ leaked: "write" }),
          patchDocument: async () => ({ leaked: "tamper" }),
          getDocument: async () => ({ leaked: "one" }),
          uploadAttachment: async () => ({ leaked: "file" }),
        },
      },
    },
  };
}

async function bodyOf(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe("setupApps — runtime invoke exposure policy", () => {
  beforeEach(() => {
    clearInvokeHandlers();
  });

  it("does not register generic MasterData CRUD actions (404 on invoke)", async () => {
    await setupApps([fakeVtexApp()]);

    for (const fn of [
      "searchDocuments",
      "createDocument",
      "patchDocument",
      "getDocument",
      "uploadAttachment",
    ]) {
      const res = await handleInvoke(invokeReq(`vtex/actions/masterData/${fn}`));
      expect(res.status, `${fn} must be unreachable`).toBe(404);
    }
  });

  it("still registers ordinary actions (cart resolves)", async () => {
    await setupApps([fakeVtexApp()]);

    const res = await handleInvoke(invokeReq("vtex/actions/checkout/getOrCreateCart"));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ ok: "cart" });
  });

  it("re-allows a denied action when the site opts in via policy.allow", async () => {
    await setupApps([fakeVtexApp()], { allow: ["searchDocuments"] });

    const allowed = await handleInvoke(
      invokeReq("vtex/actions/masterData/searchDocuments"),
    );
    expect(allowed.status).toBe(200);
    expect(await bodyOf(allowed)).toEqual({ leaked: "PII" });

    // Others stay denied — allow is surgical.
    const stillDenied = await handleInvoke(
      invokeReq("vtex/actions/masterData/createDocument"),
    );
    expect(stillDenied.status).toBe(404);
  });
});
