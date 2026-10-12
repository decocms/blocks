/**
 * `blocks.apply`'s own size guards and the secret guard.
 */
import { encryptToCiphertext, publicKeyPemFromDer } from "../../ciphertext.ts";
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

/** A throwaway public key, for endpoints that don't report one. */
async function ephemeralPublicKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  return publicKeyPemFromDer(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
}

/** A real ciphertext: encrypted with the endpoint's public key when it reports one. */
async function realCiphertext(ctx: ConformanceContext, value: string): Promise<string> {
  const publicKey = (await ctx.describe()).secrets?.publicKey ?? (await ephemeralPublicKey());
  return encryptToCiphertext(publicKey, value);
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
    id: "secrets/guard",
    title: "a Secret field accepts only a secret block with a well-formed ciphertext",
    async run(ctx) {
      await writable(ctx);
      const fixture = ctx.options.secretField;
      if (!fixture) return ctx.skip("no secretField fixture");
      const block = (value: unknown) => ({
        __resolveType: fixture.blockType,
        [fixture.field]: value,
      });
      const plain = ctx.name("plain-secret");
      const error = await expectError(
        ctx.client.blocksApply({ set: { [plain]: block("hunter2") } }),
        ErrorCode.InvalidBlock,
        "plain text in a Secret field",
      );
      const violation = (error.data as InvalidBlockData).violations[0];
      assertEqual(violation?.name, plain, "the violation names the entry");
      // Text that only looks like a ciphertext is plain text all the same.
      for (const ciphertext of ["hunter2", "v1.hunter2", "v1.my-api-key_123", "v1.QUJD.ZGVm"]) {
        await expectError(
          ctx.client.blocksApply({
            set: { [ctx.name("bad-cipher")]: block({ __resolveType: "secret", ciphertext }) },
          }),
          ErrorCode.InvalidBlock,
          `the malformed ciphertext ${JSON.stringify(ciphertext)}`,
        );
      }
      const ok = ctx.name("secret");
      const ciphertext = await realCiphertext(ctx, "conformance-value");
      await ctx.client.blocksApply({
        set: { [ok]: block({ __resolveType: "secret", ciphertext }) },
      });
      const list = await ctx.client.blocksList();
      assert(!list.notModified && ok in list.blocks, "an encrypted value is saved");
    },
  },
];
