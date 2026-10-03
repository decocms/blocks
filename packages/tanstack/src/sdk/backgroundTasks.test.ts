/**
 * Workers run no timers between requests: core background work (release
 * checks, telemetry batches) runs after the response, inside ctx.waitUntil
 * (hosted-publishing.mdx, hosted-releases-internals.mdx, telemetry-internals.mdx).
 */
import { createCMS, type Loader, resetForTests } from "@decocms/blocks";
import { setBlocks } from "@decocms/blocks/cms";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecoWorkerEntry } from "./workerEntry";

const HOOK = Symbol.for("decocms.blocks.background");

beforeEach(() => {
  resetForTests();
  setBlocks({}); // the v7 path this entry still runs reads redirects from it
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOOK];
  resetForTests();
});

function context() {
  const waited: Promise<unknown>[] = [];
  return {
    waited,
    ctx: { waitUntil: (p: Promise<unknown>) => void waited.push(p), passThroughOnException() {} },
  };
}

describe("createDecoWorkerEntry: background work", () => {
  it("runs a due release check after the response, inside ctx.waitUntil", async () => {
    const update = vi.fn(async () => ({ updated: false }));
    const loader: Loader = {
      load: async () => ({ revision: "r1", blocks: {} }),
      update,
    };
    const cms = createCMS({ blocks: {}, content: loader });
    let checkedBeforeResponse = true;
    const worker = createDecoWorkerEntry(
      {
        fetch: async () => {
          cms.forRelease();
          await Promise.resolve();
          checkedBeforeResponse = update.mock.calls.length > 0;
          return new Response("ok");
        },
      },
      { observability: false },
    );
    const { waited, ctx } = context();
    const response = await worker.fetch(new Request("https://example.com/"), {}, ctx);
    expect(await response.text()).toBe("ok");
    expect(checkedBeforeResponse).toBe(false);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("calls waitUntil only when there's something queued", async () => {
    const worker = createDecoWorkerEntry(
      { fetch: async () => new Response("ok") },
      { observability: false },
    );
    const { waited, ctx } = context();
    await worker.fetch(new Request("https://example.com/"), {}, ctx);
    expect(waited).toHaveLength(0);
  });
});
