// @vitest-environment node
import { describe, expect, it } from "vitest";
import { conformanceCases, defineConformanceSuite, runConformance } from "../conformance";
import { createContentHandler } from "../server";
import { createMemoryStorage, type MemoryStorage } from "../storage/memory";
import { SECRET_BLOCK, SECRET_FIELD, schemaFixture } from "./fixtures";

const PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n";

let storage: MemoryStorage = createMemoryStorage({
  state: { schema: JSON.stringify(schemaFixture), secretsPublicKey: PUBLIC_KEY },
});
let handler = createHandler();

function createHandler() {
  return createContentHandler(storage, {
    authorize: (request) => {
      const auth = request.headers.get("authorization");
      if (auth === "Bearer tenant-a") return { scope: "tenant-a" };
      if (auth === "Bearer tenant-b") return { scope: "tenant-b" };
      return "unauthorized";
    },
    limits: { maxListBytes: 256 * 1024 },
  });
}

defineConformanceSuite(
  { describe, it },
  {
    endpoint: "http://memory.test/rpc",
    token: "tenant-a",
    fetch: (request) => handler(request),
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
