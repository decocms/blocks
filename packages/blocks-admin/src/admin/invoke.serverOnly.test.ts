// @vitest-environment node
/**
 * `AppDefinition.serverOnly`: manifest handlers that must never be callable
 * over HTTP `/deco/invoke`, while staying available server-side.
 *
 * Regression for `vtex/actions/masterData/*`: setupApps() registers every
 * manifest export as an invoke handler, so an anonymous
 * `POST /deco/invoke/vtex/actions/masterData/searchDocumentsFull`
 * with `{ acronym: "CL" }` read the customer table with the store's appKey.
 */

import { registerSection, resolveValue, setBlocks } from "@decocms/blocks/cms";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupApps } from "../sdk/setupApps";
import {
  clearInvokeHandlers,
  handleInvoke,
  registerInvokeHandlers,
  registerServerOnlyInvokeKeys,
} from "./invoke";
import { resolvePreviewRequest } from "./resolvePreview";

const secretRead = vi.fn(async () => ({ leaked: true }));
const secretWrite = vi.fn(async () => ({ written: true }));
const publicPing = vi.fn(async () => ({ pong: true }));

const app = {
  name: "fake",
  state: {},
  manifest: {
    loaders: {},
    actions: {
      "fake/actions/masterData": { read: secretRead, write: secretWrite },
      "fake/actions/cart": { ping: publicPing },
    },
  },
  serverOnly: ["fake/actions/masterData"],
};

function post(path: string, body: unknown = {}): Request {
  return new Request(`http://localhost/deco/invoke${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  secretRead.mockClear();
  secretWrite.mockClear();
  publicPing.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await setupApps([app as any]);
});

afterEach(() => {
  clearInvokeHandlers();
  vi.restoreAllMocks();
});

describe("serverOnly handlers over HTTP", () => {
  it.each([
    "/fake/actions/masterData/read",
    "/fake/actions/masterData/read.ts",
    "/fake/actions/masterData/write",
  ])("single invoke %s answers 404 and never runs the handler", async (path) => {
    // Guard against a vacuous pass: the handler IS registered (setupApps ran).
    expect((await handleInvoke(post("/fake/actions/cart/ping"))).status).toBe(200);
    const res = await handleInvoke(post(path, { acronym: "CL" }));
    expect(res.status).toBe(404);
    expect(secretRead).not.toHaveBeenCalled();
    expect(secretWrite).not.toHaveBeenCalled();
  });

  it("batch invoke by key is refused", async () => {
    const res = await handleInvoke(post("", { "fake/actions/masterData/read": {} }));
    const body = await res.json();
    expect(body["fake/actions/masterData/read"].error).toBeDefined();
    expect(secretRead).not.toHaveBeenCalled();
  });

  it("batch invoke by __resolveType is refused", async () => {
    const res = await handleInvoke(
      post("", { x: { __resolveType: "fake/actions/masterData/read.ts" } }),
    );
    const body = await res.json();
    expect(body.x.error).toBeDefined();
    expect(secretRead).not.toHaveBeenCalled();
  });

  it("non-serverOnly handlers of the same app still work", async () => {
    const res = await handleInvoke(post("/fake/actions/cart/ping"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it("a full handler key can be marked server-only on its own", async () => {
    clearInvokeHandlers();
    await setupApps([{ ...app, serverOnly: ["fake/actions/masterData/write"] } as any]);
    expect((await handleInvoke(post("/fake/actions/masterData/write"))).status).toBe(404);
    expect((await handleInvoke(post("/fake/actions/masterData/read"))).status).toBe(200);
  });
});

describe("serverOnly handlers server-side", () => {
  it("stay reachable through the in-process ctx.invoke proxy", async () => {
    registerInvokeHandlers({
      "site/loaders/usesMasterData": async (_props: unknown, _req: Request, ctx: any) =>
        ctx.invoke.fake.actions.masterData.read({ acronym: "NL" }),
    });
    const res = await handleInvoke(post("/site/loaders/usesMasterData"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ leaked: true });
    expect(secretRead).toHaveBeenCalledTimes(1);
  });
});

describe("serverOnly handlers in preview/render request input", () => {
  const SECTION = "site/sections/Probe.tsx";

  beforeEach(() => {
    setBlocks({});
    registerSection(SECTION, async () => ({
      default: ({ title }: { title?: unknown }) => createElement("p", null, JSON.stringify(title)),
    }));
  });

  const previewPost = (body: unknown) =>
    new Request(`http://localhost/live/previews/${encodeURIComponent(SECTION)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const run = (req: Request) => resolvePreviewRequest(req).catch((e: unknown) => e);

  it("a public commerce handler nested in props still resolves (control)", async () => {
    const result: any = await run(
      previewPost({ title: { __resolveType: "fake/actions/cart/ping" } }),
    );
    expect(result.sections?.[0]?.props?.title).toEqual({ pong: true });
    expect(publicPing).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["nested in POST props", { title: { __resolveType: "fake/actions/masterData/write" } }],
    ["with a .ts suffix", { title: { __resolveType: "fake/actions/masterData/write.ts" } }],
    [
      "deeply nested",
      { title: { a: [{ b: { __resolveType: "fake/actions/masterData/write" } }] } },
    ],
    [
      "through an injected __decofile block",
      {
        __decofile: { Evil: { __resolveType: "fake/actions/masterData/write" } },
        __props: { __resolveType: SECTION, title: { __resolveType: "Evil" } },
      },
    ],
  ])("is refused %s", async (_label, body) => {
    await run(previewPost(body));
    expect(secretWrite).not.toHaveBeenCalled();
  });

  it("is refused from ?props= on GET", async () => {
    const props = encodeURIComponent(
      JSON.stringify({ title: { __resolveType: "fake/actions/masterData/read" } }),
    );
    await run(
      new Request(`http://localhost/live/previews/${encodeURIComponent(SECTION)}?props=${props}`),
    );
    expect(secretRead).not.toHaveBeenCalled();
  });

  it("server-side resolution (published content) still reaches them", async () => {
    const value = await resolveValue({ __resolveType: "fake/actions/masterData/read" });
    expect(value).toEqual({ leaked: true });
    expect(secretRead).toHaveBeenCalledTimes(1);
  });
});

describe("serverOnly entry normalization", () => {
  it.each([
    ["fake/actions/masterData.ts"],
    ["fake/actions/masterData/"],
  ])("entry %s still marks the module", async (entry) => {
    clearInvokeHandlers();
    await setupApps([{ ...app, serverOnly: [entry] } as any]);
    expect((await handleInvoke(post("/fake/actions/cart/ping"))).status).toBe(200);
    expect((await handleInvoke(post("/fake/actions/masterData/read"))).status).toBe(404);
  });

  it("covers keys from an app's explicit handlers map", async () => {
    clearInvokeHandlers();
    const explicit = vi.fn(async () => ({ explicit: true }));
    await setupApps([
      { ...app, handlers: { "fake/actions/masterData/explicit": explicit } } as any,
    ]);
    expect((await handleInvoke(post("/fake/actions/masterData/explicit"))).status).toBe(404);
    expect(explicit).not.toHaveBeenCalled();
  });
});

describe("manually registered server-only keys", () => {
  it("survive setupApps re-running (hot reload / first-request reinit)", async () => {
    const manual = vi.fn(async () => ({ manual: true }));
    registerServerOnlyInvokeKeys(["site/actions/manualSecret"]);
    registerInvokeHandlers({ "site/actions/manualSecret": manual });
    expect((await handleInvoke(post("/site/actions/manualSecret"))).status).toBe(404);

    // What autoconfig's onChange / pendingReinit does: clear + setupApps again.
    clearInvokeHandlers();
    await setupApps([app as any]);
    registerInvokeHandlers({ "site/actions/manualSecret": manual });

    expect((await handleInvoke(post("/fake/actions/cart/ping"))).status).toBe(200);
    expect((await handleInvoke(post("/site/actions/manualSecret"))).status).toBe(404);
    expect(manual).not.toHaveBeenCalled();
  });

  it("app-derived marks are still dropped when the app stops declaring them", async () => {
    clearInvokeHandlers();
    await setupApps([{ ...app, serverOnly: [] } as any]);
    expect((await handleInvoke(post("/fake/actions/masterData/read"))).status).toBe(200);
  });
});
