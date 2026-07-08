import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleDecofileRead: vi.fn(async () => new Response("decofile")),
  handleDecofileReload: vi.fn(async () => new Response("reloaded")),
  handleInvoke: vi.fn(async () => new Response("invoked")),
  handleMeta: vi.fn(() => new Response("meta")),
  handleRender: vi.fn(async (req: Request) => new Response(new URL(req.url).pathname)),
  setMetaData: vi.fn(),
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

  it("rebuilds /deco/previews/* URLs to the /live/previews/* prefix handleRender parses", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(new Request("http://x/deco/previews/pages-Home-123?props=x"));
    expect(await res.text()).toBe("/live/previews/pages-Home-123");
    const calledUrl = new URL(mocks.handleRender.mock.calls[0][0].url);
    expect(calledUrl.searchParams.get("props")).toBe("x");
  });

  it("404s unknown deco paths", async () => {
    const { GET } = createDecoRouteHandlers();
    const res = await GET(new Request("http://x/deco/nope"));
    expect(res.status).toBe(404);
  });
});
