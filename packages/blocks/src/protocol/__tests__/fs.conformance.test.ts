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
  route,
  SECRET_BLOCK,
  SECRET_FIELD,
  schemaFixture,
} from "./fixtures";
import { serve } from "./nodeServer";

let PUBLIC_KEY: string;

let root: string;
let server: Awaited<ReturnType<typeof serve>>;
let readOnlyServer: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  PUBLIC_KEY = (await generateSecretsKeyPair()).publicKeyPem;
  root = await mkdtemp(join(tmpdir(), "deco-fs-conformance-"));
  await mkdir(join(root, ".deco", "blocks"), { recursive: true });
  await writeFile(join(root, ".deco", "schema.gen.json"), JSON.stringify(schemaFixture, null, 2));
  await writeFile(join(root, ".deco", "secrets.pub"), PUBLIC_KEY);
  await writeFile(join(root, ".deco", "index.ts"), "export default {};\n");
  const storage = createFsStorage({ root });
  const handler = createContentHandler(storage, { server: { name: "deco-cli", version: "test" } });
  server = await serve(route(handler, createAssetHandler(storage)));
  const readOnlyStorage = createFsStorage({ root, readOnly: true });
  readOnlyServer = await serve(
    route(createContentHandler(readOnlyStorage), createAssetHandler(readOnlyStorage)),
  );
});

afterAll(async () => {
  await server?.close();
  await readOnlyServer?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

defineConformanceSuite(
  { describe, it },
  () => ({
    endpoint: `${server.origin}/rpc`,
    assetsEndpoint: `${server.origin}/assets/`,
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
