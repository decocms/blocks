// @vitest-environment node
import { expect, it, vi } from "vitest";

const renderer = vi.hoisted(() => vi.fn());

// These are the public SSR capabilities of the existing 1.166 router floor.
// Deliberately omit all three newer exports rather than returning undefined
// functions: loading the handler must not require missing named ESM exports.
vi.mock("@tanstack/react-router/ssr/server", () => ({
  defineHandlerCallback: (handler: unknown) => handler,
  RouterServer: () => null,
  transformReadableStreamWithRouter: (_router: unknown, stream: unknown) => stream,
}));
vi.mock("react-dom/server.edge", () => ({ renderToReadableStream: renderer }));
vi.mock("@decocms/blocks/telemetry", () => ({
  reportError: async () => {},
}));

it("imports with old SSR capabilities, preserves the ordinary Worker, and rejects only the new handler clearly", async () => {
  const { decoStreamHandler } = await import("./index.tsx");
  const { createDecoWorker } = await import("../worker/index.ts");
  const { snapshot, TestContext, testCMS } = await import("../worker/testing.ts");
  expect(typeof decoStreamHandler).toBe("function");
  const worker = createDecoWorker({
    cms: testCMS(snapshot()),
    serverEntry: { fetch: () => new Response("ordinary app") },
  });
  const ctx = new TestContext();
  const response = await worker.fetch(new Request("https://store.example/"), {}, ctx);
  await ctx.settle();
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ordinary app");
  await expect(
    decoStreamHandler({
      request: new Request("https://store.example/"),
      router: {} as never,
      responseHeaders: new Headers(),
    }),
  ).rejects.toThrow(
    "decoStreamHandler requires @tanstack/react-router >=1.170.39 and @tanstack/react-start >=1.168.58",
  );
  expect(renderer).not.toHaveBeenCalled();
});
