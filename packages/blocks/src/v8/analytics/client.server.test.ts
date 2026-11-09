// @vitest-environment node
/** On the server, `@decocms/blocks/analytics/client` imports cleanly and does nothing. */
import { expect, it } from "vitest";
import { startAnalytics } from "./client.ts";

it("importing and starting it on the server touch no browser API", async () => {
  expect(await startAnalytics({ modules: ["click", "heatmap"] })).toBeNull();
  expect((globalThis as Record<string, unknown>).__dq).toBeUndefined();
});
