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
import { createFsStorage } from "../storage/fs";
import { SECRET_BLOCK, SECRET_FIELD, schemaFixture } from "./fixtures";
import { serve } from "./nodeServer";

const TOKEN = "fs-conformance-token";
const PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMIIBojAN\n-----END PUBLIC KEY-----\n";

let root: string;
let server: Awaited<ReturnType<typeof serve>>;
let readOnlyServer: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "deco-fs-conformance-"));
  await mkdir(join(root, ".deco", "blocks"), { recursive: true });
  await writeFile(join(root, ".deco", "schema.gen.json"), JSON.stringify(schemaFixture, null, 2));
  await writeFile(join(root, ".deco", "secrets.pub"), PUBLIC_KEY);
  await writeFile(join(root, ".deco", "index.ts"), "export default {};\n");
  const storage = createFsStorage({ root, limits: { maxListBytes: 256 * 1024 } });
  const handler = createContentHandler(storage, {
    token: TOKEN,
    server: { name: "deco-cli", version: "test" },
  });
  server = await serve(handler);
  readOnlyServer = await serve(createContentHandler(createFsStorage({ root, readOnly: true })));
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
    token: TOKEN,
    secretField: { blockType: SECRET_BLOCK, field: SECRET_FIELD },
    secretsPublicKey: PUBLIC_KEY,
  }),
  "filesystem storage conformance (over HTTP)",
);

defineConformanceSuite(
  { describe, it },
  () => ({ endpoint: `${readOnlyServer.origin}/rpc`, secretsPublicKey: PUBLIC_KEY }),
  "read-only filesystem storage conformance (over HTTP)",
);
