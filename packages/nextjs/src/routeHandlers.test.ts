// @vitest-environment node
//
// Route Handlers run server-side with no DOM (same rationale as
// setup.test.ts in this package). This matters concretely here: jsdom's
// bundled Request polyfill does not reproduce Node/edge's Request-as-init
// body-stream forwarding (`new Request(url, existingRequest)`) — under
// jsdom the body-forwarding test below silently loses the body. Node's
// native Request (used in this environment, and in the real Next.js
// runtime) preserves it, which is what the previews-rebuild code path
// relies on.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleDecofileRead: vi.fn(async () => new Response("decofile")),
  handleDecofileReload: vi.fn(async () => new Response("reloaded")),
  handleInvoke: vi.fn(async () => new Response("invoked")),
  handleMeta: vi.fn(() => new Response("meta")),
  handleRender: vi.fn(async (req: Request) => new Response(new URL(req.url).pathname)),
  setMetaData: vi.fn(),
  // Real corsHeaders shape (mirrors blocks-admin/src/admin/cors.ts) so the
  // CORS assertions below test genuine header propagation, not a stub echo.
  corsHeaders: vi.fn((req: Request) => ({
    "Access-Control-Allow-Origin": req.headers.get("origin") || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, If-None-Match",
    "Access-Control-Allow-Credentials": "true",
  })),
}));
vi.mock("@decocms/blocks-admin", () => mocks);

import { setMetaData } from "@decocms/blocks-admin";
import { createDecoRouteHandlers, metaGET } from "./routeHandlers";

describe("routeHandlers (next)", () => {
  it("metaGET returns the schema response", async () => {
    setMetaData({ sections: {}, actions: {}, loaders: {} } as any);
    const response = await metaGET(new Request("https://example.com/live/_meta"));
    expect(response.status).toBe(200);
  });
});

describe("createDecoRouteHandlers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs setup before dispatching and routes decofile GET/POST", async () => {
    const order: string[] = [];
    const setup = vi.fn(async () => {
      order.push("setup");
    });
    const { GET, POST } = createDecoRouteHandlers({ setup });

    await GET(new Request("http://x/deco/decofile"));
    expect(setup).toHaveBeenCalled();
    expect(mocks.handleDecofileRead).toHaveBeenCalled();

    await POST(new Request("http://x/deco/decofile", { method: "POST" }));
    expect(mocks.handleDecofileReload).toHaveBeenCalled();
  });

  it("routes meta, render, and invoke", async () => {
    const { GET, POST } = createDecoRouteHandlers();
    await GET(new Request("http://x/deco/meta"));
    expect(mocks.handleMeta).toHaveBeenCalled();
    await POST(new Request("http://x/deco/render", { method: "POST" }));
    expect(mocks.handleRender).toHaveBeenCalled();
    await POST(new Request("http://x/deco/invoke/site/actions/x", { method: "POST" }));
    expect(mocks.handleInvoke).toHaveBeenCalled();
  });

  it("redirects preview GETs to the fixed RSC page and preserves the path and query", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(
      new Request("http://x/deco/previews/pages-Home-123?props=x&deviceHint=mobile"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://x/deco/preview/pages-Home-123?props=x&deviceHint=mobile",
    );
    expect(mocks.handleRender).not.toHaveBeenCalled();
  });

  it("redirects the public /live/previews path to the fixed RSC page", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(
      new Request("http://x/live/previews/site/sections/Hero.tsx?deviceHint=desktop"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://x/deco/preview/site/sections/Hero.tsx?deviceHint=desktop",
    );
    expect(mocks.handleRender).not.toHaveBeenCalled();
  });

  it("keeps preview POSTs on handleRender", async () => {
    const { POST } = createDecoRouteHandlers();
    const res = await POST(
      new Request("http://x/deco/previews/pages-Home-123", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.handleRender).toHaveBeenCalledOnce();
  });

  it("forwards a POST body through the /deco/previews/* URL rebuild (Request-as-init carries the body stream)", async () => {
    // Pins the `new Request(rebuilt, request)` semantics documented on the
    // rebuild line: passing a Request as `init` clones the body stream
    // without a `duplex` option. A refactor to a plain init object would
    // throw "duplex option is required" for this POST body.
    mocks.handleRender.mockImplementationOnce(async (req: Request) => {
      const body = await req.json();
      return new Response(JSON.stringify({ pathname: new URL(req.url).pathname, body }));
    });
    const { POST } = createDecoRouteHandlers();
    const res = await POST(
      new Request("http://x/deco/previews/pages-Home-123", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
    );
    const json = await res.json();
    expect(json.pathname).toBe("/live/previews/pages-Home-123");
    expect(json.body).toEqual({ hello: "world" });
  });

  it("404s unknown deco paths", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(new Request("http://x/deco/nope"));
    expect(res.status).toBe(404);
  });

  // Regression coverage for the rewrite-source paths, not just their
  // /deco/* destinations: a Next.js App Router route handler reached via a
  // next.config.js `rewrites()` entry sees `request.url` as the ORIGINAL,
  // pre-rewrite path (verified empirically against a real `next build` +
  // `next start`) — NOT the /deco/* destination the rewrite maps to. Every
  // test above this one only ever constructs an already-/deco/*-shaped
  // Request, so it would keep passing even if the dispatcher only matched
  // that form and 404'd every real rewritten request — which is exactly
  // the bug these tests catch.
  it("routes the rewrite-source /.decofile path (not just its /deco/decofile destination)", async () => {
    const { GET, POST } = createDecoRouteHandlers();
    await GET(new Request("http://x/.decofile"));
    expect(mocks.handleDecofileRead).toHaveBeenCalled();
    await POST(new Request("http://x/.decofile", { method: "POST" }));
    expect(mocks.handleDecofileReload).toHaveBeenCalled();
  });

  it("routes the rewrite-source /live/_meta path (not just its /deco/meta destination)", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(new Request("http://x/live/_meta"));
    expect(mocks.handleMeta).toHaveBeenCalled();
    expect(res.status).not.toBe(404);
  });

  it("405s POST /live/_meta with Allow: GET (the PRE-rewrite URL form)", async () => {
    const { POST } = createDecoRouteHandlers();
    const res = await POST(new Request("http://x/live/_meta", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(mocks.handleMeta).not.toHaveBeenCalled();
  });

  it("redirects the rewrite-source /live/previews/* path to the fixed RSC page", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(new Request("http://x/live/previews/pages-Home-123?props=x"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://x/deco/preview/pages-Home-123?props=x");
    expect(mocks.handleRender).not.toHaveBeenCalled();
  });

  it("405s GET /deco/invoke/* with Allow: POST (CSRF protection — see comment on the invoke branch)", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(new Request("http://x/deco/invoke/site/actions/x"));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect(mocks.handleInvoke).not.toHaveBeenCalled();
  });

  it("405s POST /deco/meta with Allow: GET", async () => {
    const { POST } = createDecoRouteHandlers();
    const res = await POST(new Request("http://x/deco/meta", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(mocks.handleMeta).not.toHaveBeenCalled();
  });
});

describe("createDecoRouteHandlers — CORS (Studio is a cross-origin browser client)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers OPTIONS preflight with 204 + CORS headers, without running setup", async () => {
    const setup = vi.fn(async () => {});
    const { OPTIONS } = createDecoRouteHandlers({ setup });
    const res = await OPTIONS(
      new Request("http://x/live/_meta", {
        method: "OPTIONS",
        headers: {
          origin: "https://decocms.com",
          "access-control-request-method": "GET",
          "access-control-request-headers": "if-none-match",
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://decocms.com");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("If-None-Match");
    expect(setup).not.toHaveBeenCalled();
  });

  it("stamps CORS headers on successful responses (meta via pre-rewrite URL)", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(
      new Request("http://x/live/_meta", { headers: { origin: "https://admin.deco.cx" } }),
    );
    expect(await res.text()).toBe("meta");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://admin.deco.cx");
  });

  it("stamps CORS headers on method-gate 405s too", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(
      new Request("http://x/deco/invoke/site/actions/x", {
        headers: { origin: "https://decocms.com" },
      }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://decocms.com");
  });

  it("named exports carry CORS as well (metaGET)", async () => {
    const res = await metaGET(
      new Request("http://x/live/_meta", { headers: { origin: "https://decocms.com" } }),
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://decocms.com");
  });
});
