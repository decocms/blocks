// @vitest-environment node
import { describe, expect, it } from "vitest";
import { conformanceCases, defineConformanceSuite, runConformance } from "../conformance";
import { createContentHandler } from "../server";
import { createAssetHandler } from "../server/assets";
import { createMemoryStorage, type MemoryStorage } from "../storage/memory";
import { route, schemaFixture } from "./fixtures";
import { tombstoneEveryDelete } from "./tombstoneEveryDelete";

const BASE_ENTRY = "pages-Committed";
const baseFiles = { [`${BASE_ENTRY}.json`]: '{\n  "path": "/committed"\n}\n' };

const storage: MemoryStorage = createMemoryStorage({
  state: {
    schema: JSON.stringify(schemaFixture),
    files: baseFiles,
    base: baseFiles,
  },
});
const handler = route(createContentHandler(storage), createAssetHandler(storage));

defineConformanceSuite(
  { describe, it },
  {
    endpoint: "http://memory.test/rpc",
    fetch: (request) => handler(request),
    assetsEndpoint: "http://memory.test/assets/",
    baseEntry: { name: BASE_ENTRY },
  },
);

// An overlay over a base, as a hosted draft is over the published branch.
const overlayStorage: MemoryStorage = createMemoryStorage({
  state: { schema: JSON.stringify(schemaFixture), base: baseFiles, overlay: true },
});
const overlay = route(createContentHandler(overlayStorage), createAssetHandler(overlayStorage));

defineConformanceSuite(
  { describe, it },
  {
    endpoint: "http://memory.test/rpc",
    fetch: (request) => overlay(request),
    assetsEndpoint: "http://memory.test/assets/",
    baseEntry: { name: BASE_ENTRY },
  },
  "overlay memory storage conformance",
);

// An overlay that records a tombstone for every deleted name, even one the
// base doesn't have, as a hosted draft whose save never reads the base does.
const everyDeleteStorage = createMemoryStorage({
  state: { schema: JSON.stringify(schemaFixture), base: baseFiles, overlay: true },
});
const everyDelete = route(
  createContentHandler(tombstoneEveryDelete(everyDeleteStorage)),
  createAssetHandler(everyDeleteStorage),
);

defineConformanceSuite(
  { describe, it },
  {
    endpoint: "http://memory.test/rpc",
    fetch: (request) => everyDelete(request),
    assetsEndpoint: "http://memory.test/assets/",
    baseEntry: { name: BASE_ENTRY },
  },
  "overlay storage that records every deletion conformance",
);

const schemaless = createContentHandler(createMemoryStorage());

defineConformanceSuite(
  { describe, it },
  {
    endpoint: "http://memory.test/rpc",
    fetch: (request) => schemaless(request),
    hasSchema: false,
    emptyBase: true,
  },
  "schemaless memory storage conformance",
);

const readOnlyStorage = createMemoryStorage({ description: { readOnly: true } });
const readOnly = route(createContentHandler(readOnlyStorage), createAssetHandler(readOnlyStorage));

defineConformanceSuite(
  { describe, it },
  {
    endpoint: "http://memory.test/rpc",
    fetch: (request) => readOnly(request),
    assetsEndpoint: "http://memory.test/assets/",
    hasSchema: false,
  },
  "read-only memory storage conformance",
);

describe("runConformance", () => {
  it("reports every case's outcome", async () => {
    const report = await runConformance({
      endpoint: "http://memory.test/rpc",
      fetch: (request) => schemaless(request),
      hasSchema: false,
    });
    expect(report.failed).toBe(0);
    expect(report.passed + report.skipped).toBe(conformanceCases.length);
    expect(report.outcomes.find((o) => o.id === "overlay/if-match")).toMatchObject({
      status: "skipped",
    });
  });

  it("fails cases against a broken endpoint", async () => {
    const broken = createContentHandler({
      ...createMemoryStorage(),
      commit: async () => ({ status: "stale" }),
    });
    const report = await runConformance(
      { endpoint: "http://broken.test/rpc", fetch: (request) => broken(request) },
      (testCase) => testCase.id === "apply/create-and-read",
    );
    expect(report.outcomes).toEqual([
      expect.objectContaining({
        id: "apply/create-and-read",
        status: "failed",
        message: expect.stringMatching(/commit attempts/),
      }),
    ]);
  });
});
