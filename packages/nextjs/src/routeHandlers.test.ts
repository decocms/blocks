// @vitest-environment node
//
// Route Handlers run server-side with no DOM (same rationale as
// setup.test.ts in this package).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleDecofileRead: vi.fn(async () => new Response("decofile")),
  handleDecofileReload: vi.fn(async () => new Response("reloaded")),
  handleInvoke: vi.fn(async () => new Response("invoked")),
  handleMeta: vi.fn(() => new Response("meta")),
  handleRender: vi.fn(async () => new Response("render")),
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

import * as routeHandlers from "./routeHandlers";
import { createDecoRouteHandlers, invokePOST } from "./routeHandlers";

function expectNoAdminHandlerCalled() {
  expect(mocks.handleDecofileRead).not.toHaveBeenCalled();
  expect(mocks.handleDecofileReload).not.toHaveBeenCalled();
  expect(mocks.handleMeta).not.toHaveBeenCalled();
  expect(mocks.handleRender).not.toHaveBeenCalled();
}

describe("routeHandlers — exports", () => {
  it("exports only the invoke surface", () => {
    expect(Object.keys(routeHandlers).sort()).toEqual(["createDecoRouteHandlers", "invokePOST"]);
  });

  it("invokePOST calls handleInvoke and stamps CORS", async () => {
    const res = await invokePOST(
      new Request("http://x/deco/invoke/site/actions/x", {
        method: "POST",
        headers: { origin: "https://decocms.com" },
      }),
    );
    expect(await res.text()).toBe("invoked");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://decocms.com");
  });
});

describe("createDecoRouteHandlers — invoke (kept)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs setup and routes POST /deco/invoke/*", async () => {
    const setup = vi.fn(async () => {});
    const { POST } = createDecoRouteHandlers({ setup });
    const res = await POST(new Request("http://x/deco/invoke/site/actions/x", { method: "POST" }));
    expect(setup).toHaveBeenCalled();
    expect(mocks.handleInvoke).toHaveBeenCalled();
    expect(await res.text()).toBe("invoked");
  });

  it("405s GET /deco/invoke/* with Allow: POST (CSRF protection)", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(new Request("http://x/deco/invoke/site/actions/x"));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect(mocks.handleInvoke).not.toHaveBeenCalled();
  });

  it("answers OPTIONS preflight for invoke with 204 + CORS, without running setup", async () => {
    const setup = vi.fn(async () => {});
    const { OPTIONS } = createDecoRouteHandlers({ setup });
    const res = await OPTIONS(
      new Request("http://x/deco/invoke/site/actions/x", {
        method: "OPTIONS",
        headers: { origin: "https://decocms.com", "access-control-request-method": "POST" },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://decocms.com");
    expect(setup).not.toHaveBeenCalled();
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
});

describe("createDecoRouteHandlers — staff-only admin routes are hard-removed", () => {
  beforeEach(() => vi.clearAllMocks());

  const removed = [
    "/.decofile",
    "/deco/decofile",
    "/live/_meta",
    "/deco/meta",
    "/live/release",
    "/deco/render",
    "/live/previews",
    "/live/previews/pages-Home-123",
    "/deco/previews",
    "/deco/previews/site/sections/Hero.tsx",
    "/deco/preview",
    "/deco/preview/pages-Home-123",
    "/live/inspect",
    "/live/inspect/x",
    "/deco/inspect",
    "/deco/inspect/x",
  ];

  for (const path of removed) {
    for (const method of ["GET", "POST", "OPTIONS"] as const) {
      it(`${method} ${path} -> 404 and never reaches an admin handler or setup`, async () => {
        const setup = vi.fn(async () => {});
        const handlers = createDecoRouteHandlers({ setup });
        const res = await handlers[method](new Request(`http://x${path}`, { method }));
        expect(res.status).toBe(404);
        expect(setup).not.toHaveBeenCalled();
        expectNoAdminHandlerCalled();
        expect(mocks.handleInvoke).not.toHaveBeenCalled();
      });
    }
  }

  it("404s unknown deco paths", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(new Request("http://x/deco/nope"));
    expect(res.status).toBe(404);
  });
});
