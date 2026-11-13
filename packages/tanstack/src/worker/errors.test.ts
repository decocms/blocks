// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecoWorker, type DecoWorkerOptions } from "./index.ts";
import { html, removeMetrics, snapshot, TestContext, testCMS } from "./testing.ts";

interface ReportContext {
  framework: string;
  source: string;
  route?: string | (() => string | undefined | Promise<string | undefined>);
  method?: string;
  status?: number;
}

const capture = vi.hoisted(() => ({
  report: vi.fn(async (_error: unknown, _context: ReportContext) => {}),
  intake: vi.fn(async (_request: Request) => new Response(null, { status: 204 })),
}));

vi.mock("@decocms/blocks/telemetry", () => ({
  ERROR_REPORT_PATH: "/deco/_errors",
  reportError: capture.report,
  handleErrorReport: capture.intake,
}));

beforeEach(() => {
  capture.report.mockReset().mockResolvedValue(undefined);
  capture.intake.mockReset().mockImplementation(
    async (request) =>
      new Response(null, {
        status: request.method === "POST" ? 204 : 405,
        headers: { "Cache-Control": "no-store" },
      }),
  );
});

afterEach(removeMetrics);

function setup(
  respond: (request: Request) => Response | Promise<Response>,
  options: Partial<DecoWorkerOptions> = {},
) {
  const content = snapshot();
  const worker = createDecoWorker({
    cms: testCMS({
      ...content,
      blocks: {
        ...content.blocks,
        Product: { __resolveType: "page", path: "/:slug/p", sections: [] },
      },
    }),
    serverEntry: { fetch: respond },
    ...options,
  });
  const ctx = new TestContext();
  const fetch = (path = "/", init?: RequestInit) =>
    worker.fetch(new Request(`https://store.example${path}`, init), {}, ctx);
  return { fetch, ctx };
}

describe("request and render error capture", () => {
  it("reports a thrown render once and preserves the thrown object", async () => {
    const error = new Error("render failed");
    const { fetch, ctx } = setup(() => {
      throw error;
    });
    await expect(fetch()).rejects.toBe(error);
    await ctx.settle();
    expect(capture.report).toHaveBeenCalledExactlyOnceWith(error, {
      framework: "tanstack",
      source: "render",
      route: expect.any(Function),
      method: "GET",
      status: 500,
    });
  });

  it("reports a reused Error on every independent request", async () => {
    const error = new Error("shared error object");
    const { fetch, ctx } = setup(() => {
      throw error;
    });
    await expect(fetch()).rejects.toBe(error);
    await expect(fetch()).rejects.toBe(error);
    await ctx.settle();
    expect(capture.report).toHaveBeenCalledTimes(2);
  });

  it("reports returned 5xx once without consuming the response body", async () => {
    const { fetch, ctx } = setup(
      () =>
        new Response("the original body", {
          status: 503,
          headers: { "Content-Type": "text/plain", "X-Origin": "preserved" },
        }),
    );
    const response = await fetch();
    await ctx.settle();
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Origin")).toBe("preserved");
    expect(await response.text()).toBe("the original body");
    expect(capture.report).toHaveBeenCalledOnce();
    expect(capture.report.mock.calls[0]).toEqual([
      undefined,
      expect.objectContaining({ source: "render", status: 503 }),
    ]);
  });

  it("uses x-page-status when the app marks a streamed response as failed", async () => {
    const { fetch, ctx } = setup(() => html("failed section", { "x-page-status": "503" }));
    const response = await fetch();
    await ctx.settle();
    expect(response.status).toBe(503);
    expect(capture.report).toHaveBeenCalledOnce();
    expect(capture.report.mock.calls[0]?.[1].status).toBe(503);
  });

  it("captures a render exception before the cache substitutes a stale 200", async () => {
    const error = new Error("fresh render failed");
    const { fetch, ctx } = setup(
      () => {
        throw error;
      },
      {
        pageCache: async (page) => {
          try {
            return await page.render();
          } catch {
            return html("stale page", { "X-Cache": "STALE-ERROR" });
          }
        },
      },
    );
    const response = await fetch();
    await ctx.settle();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("stale page");
    expect(capture.report).toHaveBeenCalledExactlyOnceWith(
      error,
      expect.objectContaining({ source: "render" }),
    );
  });

  it("captures a background revalidation failure even when the cache swallows it", async () => {
    const error = new Error("SWR failed");
    const { fetch, ctx } = setup(
      () => {
        throw error;
      },
      {
        pageCache: async (page) => {
          page.ctx.waitUntil(page.render().catch(() => {}));
          return html("cached page", { "X-Cache": "STALE-HIT" });
        },
      },
    );
    expect((await fetch()).status).toBe(200);
    await ctx.settle();
    expect(capture.report).toHaveBeenCalledExactlyOnceWith(
      error,
      expect.objectContaining({ source: "render" }),
    );
  });

  it("captures an origin 503 before the cache substitutes a stale 200", async () => {
    const { fetch, ctx } = setup(() => new Response("unavailable", { status: 503 }), {
      pageCache: async (page) => {
        await page.render();
        return html("stale page");
      },
    });
    expect((await fetch()).status).toBe(200);
    await ctx.settle();
    expect(capture.report).toHaveBeenCalledOnce();
    expect(capture.report.mock.calls[0]?.[1]).toMatchObject({ source: "render", status: 503 });
  });

  it("reports errors outside rendering and returned custom-route failures", async () => {
    const error = new Error("custom route failed");
    const thrown = setup(() => html(), {
      routes: () => {
        throw error;
      },
    });
    await expect(thrown.fetch()).rejects.toBe(error);
    await thrown.ctx.settle();
    expect(capture.report.mock.calls[0]).toEqual([
      error,
      expect.objectContaining({ source: "request", status: 500 }),
    ]);
    const returned = setup(() => html(), {
      routes: () => new Response("route unavailable", { status: 502 }),
    });
    expect((await returned.fetch()).status).toBe(502);
    await returned.ctx.settle();
    expect(capture.report.mock.calls[1]?.[1]).toMatchObject({ source: "route", status: 502 });
    const route = capture.report.mock.calls[1]?.[1].route;
    expect(typeof route === "function" ? await route() : route).toBeUndefined();
  });

  it("passes route templates, including fixed server-function routes, without query data", async () => {
    const { fetch, ctx } = setup(() => new Response("failed", { status: 500 }));
    await fetch("/private-shopper/p?token=private");
    await fetch("/_serverFn/private-function?payload=private", { method: "POST" });
    await ctx.settle();
    const contexts = capture.report.mock.calls.map((call) => call[1]);
    expect(
      await Promise.all(
        contexts.map((context) =>
          typeof context.route === "function" ? context.route() : context.route,
        ),
      ),
    ).toEqual(["/:slug/p", "/_serverFn/*"]);
    expect(contexts[1]).toMatchObject({ source: "action", method: "POST" });
    expect(JSON.stringify(contexts)).not.toContain("private");
  });

  it("leaves successful, redirect and ordinary client-error responses quiet", async () => {
    for (const status of [200, 302, 400, 401, 403, 404, 429]) {
      const { fetch, ctx } = setup(() => new Response(null, { status }));
      expect((await fetch()).status).toBe(status);
      await ctx.settle();
    }
    expect(capture.report).not.toHaveBeenCalled();
  });

  it("does not wait for reporting before returning the failed response", async () => {
    let finish!: () => void;
    capture.report.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { fetch, ctx } = setup(() => new Response("original", { status: 500 }));
    try {
      expect((await fetch()).status).toBe(500);
    } finally {
      finish();
      await ctx.settle();
    }
  });

  it("reporting failures preserve the original thrown error", async () => {
    capture.report.mockImplementationOnce(() => {
      throw new Error("reporter failed");
    });
    const original = new Error("original failure");
    const { fetch, ctx } = setup(() => {
      throw original;
    });
    await expect(fetch()).rejects.toBe(original);
    await ctx.settle();
    expect(capture.report).toHaveBeenCalledOnce();
  });

  it("does not report a request cancelled by its client", async () => {
    const controller = new AbortController();
    const reason = new Error("client disconnected");
    const { fetch, ctx } = setup(() => {
      controller.abort(reason);
      throw reason;
    });
    await expect(fetch("/", { signal: controller.signal })).rejects.toBe(reason);
    await ctx.settle();
    expect(capture.report).not.toHaveBeenCalled();
  });
});

describe("browser error intake routing", () => {
  it("reaches the bounded intake before removed-admin, custom-route and page-cache handling", async () => {
    const app = vi.fn(() => html());
    const routes = vi.fn(() => html());
    const pageCache = vi.fn(async () => html());
    const { fetch, ctx } = setup(app, { routes, pageCache });
    const response = await fetch("/deco/_errors", {
      method: "POST",
      headers: { Origin: "https://store.example", "Content-Type": "application/json" },
      body: "{}",
    });
    await ctx.settle();
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(capture.intake).toHaveBeenCalledOnce();
    expect(capture.intake.mock.calls[0]?.[0].method).toBe("POST");
    expect(app).not.toHaveBeenCalled();
    expect(routes).not.toHaveBeenCalled();
    expect(pageCache).not.toHaveBeenCalled();
    expect(capture.report).not.toHaveBeenCalled();
  });

  it("preserves the intake's method rejection", async () => {
    const { fetch, ctx } = setup(() => html());
    expect((await fetch("/deco/_errors")).status).toBe(405);
    await ctx.settle();
    expect(capture.report).not.toHaveBeenCalled();
  });
});
