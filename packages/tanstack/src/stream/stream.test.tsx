// @vitest-environment node
import {
  createRootRoute,
  createRoute,
  createRouter,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { createRequestHandler } from "@tanstack/react-router/ssr/server";
import { type ReactNode, Suspense, use } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInScope } from "../scope/server.ts";
import { createDecoWorker } from "../worker/index.ts";
import { removeMetrics, snapshot, TestContext, testCMS } from "../worker/testing.ts";
import { decoStreamHandler } from "./index.tsx";

const capture = vi.hoisted(() => ({
  report: vi.fn(async (_error: unknown, _context: unknown) => {}),
}));

vi.mock("@decocms/blocks/telemetry", () => ({
  reportError: capture.report,
}));

beforeEach(() => {
  capture.report.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  removeMetrics();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(children: ReactNode, shell?: () => ReactNode) {
  const root = createRootRoute({
    ...(shell ? { shellComponent: shell } : {}),
    component: () => (
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          <Outlet />
          <Scripts />
        </body>
      </html>
    ),
  });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => children });
  const routeTree = root.addChildren([index]);
  const router = createRouter({ routeTree, defaultPreload: false });
  const render = (request = new Request("https://store.example/")) =>
    createRequestHandler({ request, createRouter: () => router })(decoStreamHandler);
  return { render, router };
}

describe("React Web Stream error capture", () => {
  it("renders a normal response without reporting an error", async () => {
    const { render } = fixture(<p>healthy page</p>);
    const response = await render();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("healthy page");
    expect(capture.report).not.toHaveBeenCalled();
  });

  it("reports a fatal shell error once and preserves its identity", async () => {
    const error = new Error("shell failed");
    function Broken(): ReactNode {
      throw error;
    }
    const { render } = fixture(null, Broken);
    await expect(render()).rejects.toBe(error);
    expect(capture.report).toHaveBeenCalledExactlyOnceWith(error, {
      framework: "tanstack",
      source: "render",
      method: "GET",
      route: expect.any(Function),
    });
  });

  it("preserves the ordinary renderer diagnostic when the request reporter is disabled", async () => {
    const error = new Error("local render failed");
    function Broken(): ReactNode {
      throw error;
    }
    const { render } = fixture(null, Broken);
    await expect(runInScope({ reportError: () => {} }, () => render())).rejects.toBe(error);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "Error in renderToReadableStream:",
      error,
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
    expect(capture.report).not.toHaveBeenCalled();
  });

  it("a throwing console wrapper cannot replace the render error or prevent its report", async () => {
    vi.mocked(console.error).mockImplementation(() => {
      throw new Error("console wrapper failed");
    });
    const error = new Error("original render failure");
    function Broken(): ReactNode {
      throw error;
    }
    const { render } = fixture(null, Broken);
    await expect(render()).rejects.toBe(error);
    expect(console.error).toHaveBeenCalledOnce();
    expect(capture.report).toHaveBeenCalledExactlyOnceWith(
      error,
      expect.objectContaining({ framework: "tanstack", source: "render" }),
    );
  });

  it("captures a late Suspense failure after the 200 response has started", async () => {
    const gate = deferred<void>();
    const error = new Error("late render failed");
    function BrokenLater(): ReactNode {
      use(gate.promise);
      throw error;
    }
    const { render } = fixture(
      <Suspense fallback={<p>loading</p>}>
        <BrokenLater />
      </Suspense>,
    );
    const response = await render(
      new Request("https://store.example/?token=private", {
        headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36" },
      }),
    );
    expect(response.status).toBe(200);
    expect(capture.report).not.toHaveBeenCalled();
    const body = response.text();
    gate.resolve();
    expect(await body).toContain("loading");
    expect(capture.report).toHaveBeenCalledExactlyOnceWith(error, {
      framework: "tanstack",
      source: "render",
      method: "GET",
      route: expect.any(Function),
    });
  });

  it("waits for a bot's Suspense content before returning the response", async () => {
    const gate = deferred<void>();
    const rendering = vi.fn();
    function Deferred(): ReactNode {
      rendering();
      use(gate.promise);
      return <p>ready for indexing</p>;
    }
    const { render } = fixture(
      <Suspense fallback="loading">
        <Deferred />
      </Suspense>,
    );
    let returned = false;
    const response = render(
      new Request("https://store.example/", {
        headers: { "User-Agent": "Googlebot" },
      }),
    ).then((value) => {
      returned = true;
      return value;
    });
    await vi.waitFor(() => expect(rendering).toHaveBeenCalled());
    expect(returned).toBe(false);
    gate.resolve();
    expect(await (await response).text()).toContain("ready for indexing");
    expect(capture.report).not.toHaveBeenCalled();
  });

  it("keeps an already-aborted request quiet and cleans up its router", async () => {
    const controller = new AbortController();
    const reason = new Error("client disconnected");
    controller.abort(reason);
    const cleanup = vi.fn();
    await expect(
      decoStreamHandler({
        request: new Request("https://store.example/", { signal: controller.signal }),
        router: { serverSsr: { cleanup } } as never,
        responseHeaders: new Headers(),
      }),
    ).rejects.toBe(reason);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(capture.report).not.toHaveBeenCalled();
  });

  it("aborts bot readiness without recording a client cancellation as an error", async () => {
    const gate = deferred<void>();
    const rendering = vi.fn();
    function Deferred(): ReactNode {
      rendering();
      use(gate.promise);
      return <p>ready</p>;
    }
    const { render } = fixture(
      <Suspense fallback="loading">
        <Deferred />
      </Suspense>,
    );
    const controller = new AbortController();
    const reason = new Error("client disconnected");
    const response = render(
      new Request("https://store.example/", {
        signal: controller.signal,
        headers: { "User-Agent": "Googlebot" },
      }),
    );
    await vi.waitFor(() => expect(rendering).toHaveBeenCalled());
    const rejected = expect(response).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    gate.resolve();
    expect(capture.report).not.toHaveBeenCalled();
  });

  it("cancelling the response stream stops the renderer without an error event", async () => {
    const gate = deferred<void>();
    function Deferred(): ReactNode {
      use(gate.promise);
      return <p>ready</p>;
    }
    const { render, router } = fixture(
      <Suspense fallback="loading">
        <Deferred />
      </Suspense>,
    );
    const response = await render(
      new Request("https://store.example/", {
        headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36" },
      }),
    );
    const cleanup = vi.spyOn(router.serverSsr!, "cleanup");
    await response.body!.cancel(new Error("consumer closed stream"));
    gate.resolve();
    expect(cleanup).toHaveBeenCalled();
    expect(capture.report).not.toHaveBeenCalled();
  });

  it("shares the Worker's per-request reporter, avoiding shell/catch duplicates", async () => {
    const error = new Error("shell failed");
    function Broken(): ReactNode {
      throw error;
    }
    const { render } = fixture(null, Broken);
    const worker = createDecoWorker({
      cms: testCMS(snapshot()),
      serverEntry: { fetch: render },
    });
    const ctx = new TestContext();
    await expect(worker.fetch(new Request("https://store.example/"), {}, ctx)).rejects.toBe(error);
    await ctx.settle();
    expect(capture.report).toHaveBeenCalledExactlyOnceWith(
      error,
      expect.objectContaining({ framework: "tanstack", source: "render" }),
    );
  });
});
