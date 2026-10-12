// @vitest-environment node
import { describe, expect, it } from "vitest";
import { conformanceCases, defineConformanceSuite, runConformance } from "../conformance";
import { createContentHandler } from "../server";
import { createAssetHandler } from "../server/assets";
import { createMemoryStorage, type MemoryStorage } from "../storage/memory";
import {
  generateSecretsKeyPair,
  route,
  SECRET_BLOCK,
  SECRET_FIELD,
  schemaFixture,
} from "./fixtures";

const { publicKeyPem: PUBLIC_KEY } = await generateSecretsKeyPair();

const storage: MemoryStorage = createMemoryStorage({
  state: { schema: JSON.stringify(schemaFixture), secretsPublicKey: PUBLIC_KEY },
});
const handler = route(createContentHandler(storage), createAssetHandler(storage));

defineConformanceSuite(
  { describe, it },
  {
    endpoint: "http://memory.test/rpc",
    fetch: (request) => handler(request),
    assetsEndpoint: "http://memory.test/assets/",
    secretField: { blockType: SECRET_BLOCK, field: SECRET_FIELD },
    secretsPublicKey: PUBLIC_KEY,
  },
);

const schemaless = createContentHandler(createMemoryStorage());

defineConformanceSuite(
  { describe, it },
  { endpoint: "http://memory.test/rpc", fetch: (request) => schemaless(request), hasSchema: false },
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
    expect(report.outcomes.find((o) => o.id === "secrets/guard")).toMatchObject({
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
