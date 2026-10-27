// @vitest-environment node
/**
 * The conformance suite against the filesystem storage, served over real HTTP
 * from a temporary app root inside a git repository — the setup `deco serve`
 * uses. The base is the repository's HEAD: one run with a committed entry,
 * one on a repository with no commits yet (an empty base).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { defineConformanceSuite } from "../conformance";
import { createContentHandler } from "../server";
import { createAssetHandler } from "../server/assets";
import { createFsStorage } from "../storage/fs";
import { route, schemaFixture } from "./fixtures";
import { gitInit } from "./git";
import { serve } from "./nodeServer";

const BASE_ENTRY = "pages-Committed";

let root: string;
let unbornRoot: string;
let server: Awaited<ReturnType<typeof serve>>;
let readOnlyServer: Awaited<ReturnType<typeof serve>>;
let unbornServer: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "deco-fs-conformance-"));
  await mkdir(join(root, ".deco", "blocks"), { recursive: true });
  await writeFile(join(root, ".deco", "schema.gen.json"), JSON.stringify(schemaFixture, null, 2));
  // A key a 8.x site may still have committed: describe never reports it.
  await writeFile(
    join(root, ".deco", "secrets.pub"),
    "-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----\n",
  );
  await writeFile(join(root, ".deco", "index.ts"), "export default {};\n");
  await writeFile(
    join(root, ".deco", "blocks", `${BASE_ENTRY}.json`),
    `${JSON.stringify({ path: "/committed", title: "In HEAD" }, null, 2)}\n`,
  );
  gitInit(root);
  unbornRoot = await mkdtemp(join(tmpdir(), "deco-fs-conformance-unborn-"));
  await mkdir(join(unbornRoot, ".deco", "blocks"), { recursive: true });
  gitInit(unbornRoot, { commit: false });
  unbornServer = await serve(createContentHandler(createFsStorage({ root: unbornRoot })));
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
  await unbornServer?.close();
  if (root) await rm(root, { recursive: true, force: true });
  if (unbornRoot) await rm(unbornRoot, { recursive: true, force: true });
});

defineConformanceSuite(
  { describe, it },
  () => ({
    endpoint: `${server.origin}/rpc`,
    assetsEndpoint: `${server.origin}/assets/`,
    baseEntry: { name: BASE_ENTRY },
  }),
  "filesystem storage conformance (over HTTP)",
);

defineConformanceSuite(
  { describe, it },
  () => ({ endpoint: `${unbornServer.origin}/rpc`, hasSchema: false, emptyBase: true }),
  "filesystem storage conformance, repository without commits (over HTTP)",
  (testCase) => !testCase.id.startsWith("assets/"),
);

defineConformanceSuite(
  { describe, it },
  () => ({
    endpoint: `${readOnlyServer.origin}/rpc`,
    assetsEndpoint: `${readOnlyServer.origin}/assets/`,
  }),
  "read-only filesystem storage conformance (over HTTP)",
);
