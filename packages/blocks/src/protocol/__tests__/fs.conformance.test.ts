// @vitest-environment node
/**
 * The conformance suite against the filesystem storage, served over real HTTP
 * from a temporary app root — the setup `deco serve` uses.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { defineConformanceSuite } from "../conformance";
import { createContentHandler } from "../server";
import { createAssetHandler } from "../server/assets";
import { createFsStorage } from "../storage/fs";
import {
  generateSecretsKeyPair,
  PROBE_LIMITS,
  route,
  SECRET_BLOCK,
  SECRET_FIELD,
  schemaFixture,
} from "./fixtures";
import { serve } from "./nodeServer";

const TOKEN = "fs-conformance-token";
let PUBLIC_KEY: string;

let root: string;
let server: Awaited<ReturnType<typeof serve>>;
let readOnlyServer: Awaited<ReturnType<typeof serve>>;
let schemaLimitedServer: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  PUBLIC_KEY = (await generateSecretsKeyPair()).publicKeyPem;
  root = await mkdtemp(join(tmpdir(), "deco-fs-conformance-"));
  await mkdir(join(root, ".deco", "blocks"), { recursive: true });
  await writeFile(join(root, ".deco", "schema.gen.json"), JSON.stringify(schemaFixture, null, 2));
  await writeFile(join(root, ".deco", "secrets.pub"), PUBLIC_KEY);
  await writeFile(join(root, ".deco", "index.ts"), "export default {};\n");
  const storage = createFsStorage({ root, limits: PROBE_LIMITS });
  const handler = createContentHandler(storage, {
    token: TOKEN,
    server: { name: "deco-cli", version: "test" },
  });
  server = await serve(route(handler, createAssetHandler(storage, { token: TOKEN })));
  const readOnlyStorage = createFsStorage({ root, readOnly: true });
  readOnlyServer = await serve(
    route(createContentHandler(readOnlyStorage), createAssetHandler(readOnlyStorage)),
  );
  schemaLimitedServer = await serve(
    createContentHandler(createFsStorage({ root, limits: { maxSchemaBytes: 128 } })),
  );
});

afterAll(async () => {
  await server?.close();
  await readOnlyServer?.close();
  await schemaLimitedServer?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

defineConformanceSuite(
  { describe, it },
  () => ({
    endpoint: `${server.origin}/rpc`,
    assetsEndpoint: `${server.origin}/assets/`,
    token: TOKEN,
    secretField: { blockType: SECRET_BLOCK, field: SECRET_FIELD },
    secretsPublicKey: PUBLIC_KEY,
  }),
  "filesystem storage conformance (over HTTP)",
);

defineConformanceSuite(
  { describe, it },
  () => ({
    endpoint: `${readOnlyServer.origin}/rpc`,
    assetsEndpoint: `${readOnlyServer.origin}/assets/`,
    secretsPublicKey: PUBLIC_KEY,
  }),
  "read-only filesystem storage conformance (over HTTP)",
);

defineConformanceSuite(
  { describe, it },
  () => ({ endpoint: `${schemaLimitedServer.origin}/rpc`, schemaOverLimit: true }),
  "filesystem storage with a schema over its limit (over HTTP)",
  (testCase) => testCase.id === "limits/schema-bytes",
);
