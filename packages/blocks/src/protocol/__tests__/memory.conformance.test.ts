// @vitest-environment node
import { describe, expect, it } from "vitest";
import { conformanceCases, defineConformanceSuite, runConformance } from "../conformance";
import { createContentHandler } from "../server";
import { createAssetHandler } from "../server/assets";
import { createMemoryStorage, type MemoryStorage } from "../storage/memory";
import {
  generateSecretsKeyPair,
  PROBE_LIMITS,
  route,
  SECRET_BLOCK,
  SECRET_FIELD,
  schemaFixture,
} from "./fixtures";

const { publicKeyPem: PUBLIC_KEY } = await generateSecretsKeyPair();

let storage: MemoryStorage = createMemoryStorage({
  state: { schema: JSON.stringify(schemaFixture), secretsPublicKey: PUBLIC_KEY },
});
let handler = createHandler();

function createHandler() {
  const authorize = (request: Request) => {
    const auth = request.headers.get("authorization");
    if (auth === "Bearer tenant-a") return { scope: "tenant-a" };
    if (auth === "Bearer tenant-b") return { scope: "tenant-b" };
    return "unauthorized" as const;
  };
  return route(
    createContentHandler(storage, { authorize, limits: PROBE_LIMITS }),
    createAssetHandler(storage, { authorize }),
  );
}

defineConformanceSuite(
  { describe, it },
  {
    endpoint: "http://memory.test/rpc",
    token: "tenant-a",
    fetch: (request) => handler(request),
    assetsEndpoint: "http://memory.test/assets/",
    secretField: { blockType: SECRET_BLOCK, field: SECRET_FIELD },
    secretsPublicKey: PUBLIC_KEY,
    otherTenant: { token: "tenant-b" },
    restart: async () => {
      // A new process: fresh handler, storage rebuilt from its durable state.
      storage = createMemoryStorage({ state: storage.dump() });
      handler = createHandler();
    },
  },
);

const schemaless = createContentHandler(createMemoryStorage());

defineConformanceSuite(
  { describe, it },
  { endpoint: "http://memory.test/rpc", fetch: (request) => schemaless(request), hasSchema: false },
  "schemaless memory storage conformance",
);

const schemaOverLimit = createContentHandler(
  createMemoryStorage({ state: { schema: JSON.stringify(schemaFixture) } }),
  { limits: { maxSchemaBytes: 128 } },
);

defineConformanceSuite(
  { describe, it },
  {
    endpoint: "http://memory.test/rpc",
    fetch: (request) => schemaOverLimit(request),
    schemaOverLimit: true,
  },
  "memory storage with a schema over its limit",
  (testCase) => testCase.id === "limits/schema-bytes",
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
