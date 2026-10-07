/**
 * `describe`, `schema.get` and `blocks.list`, including conditional reads.
 */
import { PROTOCOL_NAME, SCHEMA_FORMAT } from "../../types.ts";
import { assert, assertEqual } from "../context.ts";
import type { ConformanceCase } from "./types.ts";

export const readCases: ConformanceCase[] = [
  {
    id: "describe/shape",
    title: "describe reports the protocol, its version, kind, root and features",
    async run(ctx) {
      const d = await ctx.client.describe();
      assertEqual(d.protocol, PROTOCOL_NAME, "protocol");
      assertEqual(d.version.major, 1, "version.major");
      assert(Number.isInteger(d.version.minor) && d.version.minor >= 0, "version.minor");
      assert(typeof d.server?.name === "string" && typeof d.server?.version === "string", "server");
      assert(d.kind === "working-tree" || d.kind === "git", `kind ${String(d.kind)}`);
      assert(typeof d.readOnly === "boolean", "readOnly");
      assert(typeof d.root === "string" && !d.root.startsWith("/"), "root is relative");
      assertEqual(d.schemaFormat, SCHEMA_FORMAT, "schemaFormat");
      assert(d.pollIntervalMs > 0, "pollIntervalMs");
      assert(
        d.preview === null || /^https?:\/\//.test(String(d.preview?.url)),
        "preview is null or { url } with an http(s) URL",
      );
      if (d.readOnly) assertEqual(d.assets, null, "assets is null when read-only");
      if (d.assets) {
        assertEqual(d.assets.urlPrefix, "/assets/", "assets.urlPrefix");
        assert(d.assets.maxBytes > 0 && typeof d.assets.dir === "string", "assets");
      }
      assert(d.secrets === null || typeof d.secrets.publicKey === "string", "secrets");
    },
  },
  {
    id: "describe/secrets",
    title: "describe returns the committed public key for secrets",
    async run(ctx) {
      const expected = ctx.options.secretsPublicKey;
      if (expected === undefined) return ctx.skip("no secretsPublicKey fixture");
      const d = await ctx.client.describe();
      assertEqual(d.secrets, { publicKey: expected }, "describe.secrets");
    },
  },
  {
    id: "schema/read",
    title: "schema.get returns the schema and a version, and 'not modified' for that version",
    async run(ctx) {
      if (ctx.options.hasSchema === false) return ctx.skip("no schema (see schema/absent)");
      const first = await ctx.client.schemaGet();
      assert(!first.notModified && first.schema !== null, "the first read returns the schema");
      assert(typeof first.version === "string" && first.version.length > 0, "a version");
      assert(typeof first.schema === "object" && first.schema !== null, "a schema object");
      const again = await ctx.client.schemaGet({ ifNoneMatch: first.version });
      assertEqual(again, { notModified: true, version: first.version }, "the conditional read");
      const stale = await ctx.client.schemaGet({ ifNoneMatch: `${first.version}-stale` });
      assert(!stale.notModified, "another version returns the schema");
    },
  },
  {
    id: "schema/absent",
    title: "without a schema, schema.get is schema: null (not an error) and blocks still list",
    async run(ctx) {
      if (ctx.options.hasSchema !== false) return ctx.skip("the endpoint has a schema");
      const result = await ctx.client.schemaGet();
      assertEqual(
        result,
        {
          notModified: false,
          version: null,
          resolvedRef: result.notModified ? null : result.resolvedRef,
          schema: null,
        },
        "the no-schema result",
      );
      const list = await ctx.client.blocksList();
      assert(!list.notModified, "blocks.list returns the map without a schema");
    },
  },
  {
    id: "list/read",
    title: "blocks.list returns every entry with versions, and 'not modified' for its revision",
    async run(ctx) {
      const first = await ctx.client.blocksList();
      assert(!first.notModified, "the first read returns the map");
      assert(typeof first.revision === "string" && first.revision.length > 0, "a revision");
      assert(Array.isArray(first.diagnostics), "diagnostics");
      assertEqual(
        Object.keys(first.versions).sort(),
        Object.keys(first.blocks).sort(),
        "one version per entry",
      );
      assert(
        first.resolvedRef === null || typeof first.resolvedRef === "string",
        "resolvedRef is a branch or null",
      );
      const again = await ctx.client.blocksList({ ifNoneMatch: first.revision });
      assertEqual(
        again,
        { notModified: true, revision: first.revision, resolvedRef: first.resolvedRef },
        "the conditional read",
      );
    },
  },
  {
    id: "list/poll-batch",
    title: "one batched poll reads the schema and the blocks conditionally",
    async run(ctx) {
      const list = await ctx.client.blocksList();
      const calls = [{ method: "blocks.list" as const, params: { ifNoneMatch: list.revision } }];
      const outcomes = await ctx.client.batch(
        ctx.options.hasSchema === false
          ? calls
          : [
              {
                method: "schema.get" as const,
                params: { ifNoneMatch: (await ctx.client.schemaGet()).version ?? undefined },
              },
              ...calls,
            ],
      );
      for (const outcome of outcomes) {
        assert(outcome.ok, "every poll call succeeds");
        assert((outcome.result as { notModified: boolean }).notModified, "nothing changed");
      }
    },
  },
];
