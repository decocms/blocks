/**
 * `blocks.apply`'s own size guards, and the checks it leaves to `deco check`.
 */
import { ErrorCode, type InvalidBlockData } from "../../errors.ts";
import { MAX_BLOCK_BYTES, MAX_OPS_PER_APPLY, MAX_REQUEST_BYTES } from "../../server/core.ts";
import {
  assert,
  assertEqual,
  type ConformanceContext,
  expectError,
  rawErrorCode,
} from "../context.ts";
import type { ConformanceCase } from "./types.ts";

async function writable(ctx: ConformanceContext) {
  const d = await ctx.describe();
  if (d.readOnly) return ctx.skip("read-only endpoint");
  return d;
}

export const guardCases: ConformanceCase[] = [
  {
    id: "limits/ops-per-apply",
    title: "more names than one blocks.apply takes is LimitExceeded",
    async run(ctx) {
      await writable(ctx);
      const names = Array.from(
        { length: MAX_OPS_PER_APPLY + 1 },
        (_, i) => `${ctx.prefix}-op-${i}`,
      );
      await expectError(
        ctx.client.blocksApply({ delete: names }),
        ErrorCode.LimitExceeded,
        "too many names",
      );
    },
  },
  {
    id: "limits/block-bytes",
    title: "an entry over the block size limit is refused and nothing is written",
    async run(ctx) {
      await writable(ctx);
      const big = ctx.name("big");
      const small = ctx.name("small");
      const error = await expectError(
        ctx.client.blocksApply({
          set: { [big]: { text: "x".repeat(MAX_BLOCK_BYTES) }, [small]: { ok: true } },
        }),
        ErrorCode.InvalidBlock,
        "an oversized entry",
      );
      const violations = (error.data as InvalidBlockData).violations;
      assert(
        violations.some((v) => v.name === big),
        "the violation names the entry",
      );
      const list = await ctx.client.blocksList();
      assert(!list.notModified && !(small in list.blocks), "nothing was written");
    },
  },
  {
    id: "limits/request-bytes",
    title: "a body over the request size limit is HTTP 413 with LimitExceeded",
    async run(ctx) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "blocks.apply",
        params: { set: { [ctx.name("huge")]: { text: "x".repeat(MAX_REQUEST_BYTES) } } },
      });
      const response = await ctx.raw(body);
      assertEqual(response.status, 413, "HTTP status");
      assertEqual(rawErrorCode(response.body), ErrorCode.LimitExceeded, "the error code");
    },
  },
  {
    id: "writes/schema-free",
    title: "blocks.apply saves any JSON object, whatever the schema says about it",
    async run(ctx) {
      await writable(ctx);
      // The schema is `deco check`'s business, in the site's CI: a write never reads it.
      const values = {
        [ctx.name("unknown-type")]: { __resolveType: "conformance/not-in-any-schema.tsx", x: 1 },
        [ctx.name("v7-secret")]: {
          __resolveType: "website/loaders/secret.ts",
          encrypted: "not-a-ciphertext",
        },
        [ctx.name("plain-field")]: { __resolveType: "secret", ciphertext: "hunter2" },
        [ctx.name("no-type")]: { title: 42, sections: "not a list" },
      };
      const applied = await ctx.client.blocksApply({ set: values });
      const list = await ctx.client.blocksList();
      assert(!list.notModified, "an unconditional list returns the map");
      for (const [name, value] of Object.entries(values)) {
        assertEqual(list.blocks[name], value, `${name} is saved as sent`);
        assertEqual(list.versions[name], applied.versions[name], `${name}'s version`);
      }
    },
  },
];
