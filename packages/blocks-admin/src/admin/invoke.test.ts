/**
 * Regression tests for /deco/invoke Set-Cookie propagation.
 *
 * The historical bug: the single- and batch-invoke paths copied
 * `RequestContext.responseHeaders` to the HTTP response via
 * `headers.entries()`, which collapses multiple `Set-Cookie` values
 * into a single comma-joined string. Browsers silently discard those,
 * so every VTEX cart action lost its session cookies and the user
 * ended up at /checkout with an empty cart.
 *
 * These tests pin the fix: when a handler appends multiple
 * Set-Cookie values to `RequestContext.responseHeaders`, the response
 * returned by `handleInvoke` must surface them as N distinct
 * Set-Cookie headers (readable via `response.headers.getSetCookie()`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDraftCache, loadBlocks, setBlocks } from "@decocms/blocks/cms";
import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import {
  clearInvokeHandlers,
  handleInvoke,
  registerInvokeHandlers,
} from "./invoke";

const COOKIE_A = "checkout.vtex.com__orderFormId=of-123; Path=/; HttpOnly";
const COOKIE_B = "segment=eyJjYW1wYWlnbnMiOiJ4In0=; Path=/; HttpOnly";
const COOKIE_C = "sc=1; Path=/; HttpOnly";

function makeInvokeRequest(key: string, body: unknown = {}): Request {
  return new Request(`http://localhost/deco/invoke/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeBatchRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/deco/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleInvoke — Set-Cookie propagation (single)", () => {
  beforeEach(() => clearInvokeHandlers());
  afterEach(() => clearInvokeHandlers());

  it("forwards multiple Set-Cookie values as distinct headers", async () => {
    registerInvokeHandlers({
      "vtex/actions/addItemsToCart": async () => {
        RequestContext.responseHeaders.append("set-cookie", COOKIE_A);
        RequestContext.responseHeaders.append("set-cookie", COOKIE_B);
        RequestContext.responseHeaders.append("set-cookie", COOKIE_C);
        return { orderFormId: "of-123" };
      },
    });

    const request = makeInvokeRequest("vtex/actions/addItemsToCart");
    const response = await RequestContext.run(request, () =>
      handleInvoke(request),
    );

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    expect(cookies).toContain(COOKIE_A);
    expect(cookies).toContain(COOKIE_B);
    expect(cookies).toContain(COOKIE_C);
  });

  it("does not collapse cookies into a single Set-Cookie entry", async () => {
    registerInvokeHandlers({
      "vtex/actions/foo": async () => {
        RequestContext.responseHeaders.append("set-cookie", COOKIE_A);
        RequestContext.responseHeaders.append("set-cookie", COOKIE_B);
        return {};
      },
    });

    const request = makeInvokeRequest("vtex/actions/foo");
    const response = await RequestContext.run(request, () =>
      handleInvoke(request),
    );

    // The regressed bug appended a single comma-joined string, so
    // `getSetCookie()` returned a 1-element array. The fix appends each
    // value individually — verifying the count alone catches the regression.
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it("forwards non-cookie headers unchanged", async () => {
    registerInvokeHandlers({
      "vtex/actions/withHeader": async () => {
        RequestContext.responseHeaders.append("x-vtex-trace-id", "abc-123");
        return {};
      },
    });

    const request = makeInvokeRequest("vtex/actions/withHeader");
    const response = await RequestContext.run(request, () =>
      handleInvoke(request),
    );
    expect(response.headers.get("x-vtex-trace-id")).toBe("abc-123");
  });

  it("does not forward Set-Cookie when handler writes none", async () => {
    registerInvokeHandlers({
      "vtex/loaders/productList": async () => ({ items: [] }),
    });

    const request = makeInvokeRequest("vtex/loaders/productList");
    const response = await RequestContext.run(request, () =>
      handleInvoke(request),
    );
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("handleInvoke — Set-Cookie propagation (batch)", () => {
  beforeEach(() => clearInvokeHandlers());
  afterEach(() => clearInvokeHandlers());

  it("forwards cookies that batch handlers append to the shared context", async () => {
    registerInvokeHandlers({
      "vtex/actions/addItemsToCart": async () => {
        RequestContext.responseHeaders.append("set-cookie", COOKIE_A);
        RequestContext.responseHeaders.append("set-cookie", COOKIE_B);
        return { orderFormId: "of-123" };
      },
      "vtex/loaders/productList": async () => {
        // Loader writes its own cookie (e.g. segment) — must also propagate.
        RequestContext.responseHeaders.append("set-cookie", COOKIE_C);
        return { items: [] };
      },
    });

    const request = makeBatchRequest({
      "vtex/actions/addItemsToCart": { orderFormId: "x" },
      "vtex/loaders/productList": {},
    });
    const response = await RequestContext.run(request, () =>
      handleInvoke(request),
    );

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    expect(cookies).toContain(COOKIE_A);
    expect(cookies).toContain(COOKIE_B);
    expect(cookies).toContain(COOKIE_C);
  });
});

/**
 * Draft binding: /deco/invoke is a separate request from the page render, so
 * the page's request-scoped draft never reaches it. handleInvoke must
 * re-resolve the draft from the request it received and bind it, or a
 * client-fetched (lazy) section resolves its loaders against PUBLISHED blocks.
 */
describe("handleInvoke — draft binding", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    clearInvokeHandlers();
    clearDraftCache();
    setBlocks({ "site/x": { value: "published" } });
    registerInvokeHandlers({
      "site/loaders/x.ts": async () =>
        (loadBlocks() as Record<string, any>)["site/x"],
    });
  });
  afterEach(() => {
    clearInvokeHandlers();
    clearDraftCache();
    globalThis.fetch = origFetch;
    delete process.env.DECO_ALLOWED_PREVIEW_HOSTS;
  });

  function invokeReq(headers: Record<string, string>): Request {
    return new Request(
      "https://preview.example/deco/invoke/site/loaders/x.ts",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      },
    );
  }

  it("resolves loaders against the DRAFT when the request carries an allowed draft cookie", async () => {
    process.env.DECO_ALLOWED_PREVIEW_HOSTS = "preview.example";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ "site/x": { value: "draft" } }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const res = await handleInvoke(
      invokeReq({
        "x-forwarded-host": "preview.example",
        cookie:
          "__deco_draft=studio.decocms.com/api/o/decofile/m/main%3Ftoken%3Dt@vX",
      }),
    );
    expect(await res.json()).toEqual({ value: "draft" });
  });

  it("resolves against PUBLISHED blocks when no draft cookie is present — no network", async () => {
    process.env.DECO_ALLOWED_PREVIEW_HOSTS = "preview.example";
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const res = await handleInvoke(
      invokeReq({ "x-forwarded-host": "preview.example" }),
    );
    expect(await res.json()).toEqual({ value: "published" });
    expect(called).toBe(false);
  });

  it("ignores a draft cookie on a non-allowed host (production stays published)", async () => {
    process.env.DECO_ALLOWED_PREVIEW_HOSTS = "preview.example";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ "site/x": { value: "draft" } }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const res = await handleInvoke(
      invokeReq({
        "x-forwarded-host": "prod.example",
        cookie:
          "__deco_draft=studio.decocms.com/api/o/decofile/m/main%3Ftoken%3Dt@vX",
      }),
    );
    expect(await res.json()).toEqual({ value: "published" });
  });
});
