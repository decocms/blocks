/**
 * Overlay endpoints (protocol 1.2, `describe.overlay`), such as a hosted
 * draft over the published branch: `blocks.apply`'s `ifMatch` compares with
 * the overlay alone, and `changes.list` is the overlay's own entries. Every
 * case skips on an endpoint that isn't an overlay.
 */
import { ErrorCode } from "../../errors.ts";
import type { BlocksListResult, ChangesListResult } from "../../types.ts";
import { assert, assertEqual, type ConformanceContext, expectError } from "../context.ts";
import type { ConformanceCase } from "./types.ts";

type FullList = Extract<BlocksListResult, { notModified: false }>;
type FullChanges = Extract<ChangesListResult, { notModified: false }>;

async function list(ctx: ConformanceContext): Promise<FullList> {
  const result = await ctx.client.blocksList();
  assert(!result.notModified, "an unconditional list returns the map");
  return result;
}

async function changes(ctx: ConformanceContext): Promise<FullChanges> {
  const result = await ctx.client.changesList();
  assert(!result.notModified, "an unconditional changes.list returns the changes");
  return result;
}

async function overlay(ctx: ConformanceContext) {
  const d = await ctx.describe();
  if (d.overlay !== true) return ctx.skip("not an overlay endpoint");
  if (d.readOnly) return ctx.skip("read-only endpoint");
  return d;
}

/** The harness's base entry, which the overlay doesn't hold yet. */
async function baseEntry(ctx: ConformanceContext) {
  const name = ctx.options.baseEntry?.name;
  if (name === undefined) return ctx.skip("no baseEntry");
  const blocks = await list(ctx);
  assert(name in blocks.blocks, `the baseEntry "${name}" exists`);
  assert(!(name in (await changes(ctx)).changes), `the overlay doesn't hold "${name}" yet`);
  return { name, value: blocks.blocks[name]!, version: blocks.versions[name]! };
}

export const overlayCases: ConformanceCase[] = [
  {
    id: "overlay/if-match",
    title: "on an overlay, ifMatch null means the overlay doesn't hold the entry yet",
    async run(ctx) {
      await overlay(ctx);
      const name = ctx.name("guarded");
      const first = await ctx.client.blocksApply({
        set: { [name]: { v: 1 } },
        ifMatch: { [name]: null },
      });
      const error = await expectError(
        ctx.client.blocksApply({ set: { [name]: { v: 2 } }, ifMatch: { [name]: null } }),
        ErrorCode.Conflict,
        "ifMatch null on an entry the overlay holds",
      );
      assertEqual(
        (error.data as { entries?: unknown })?.entries,
        { [name]: { expected: null, actual: first.versions[name] } },
        "the conflict's entries",
      );
      const listed = (await changes(ctx)).changes[name];
      assertEqual(
        listed?.version,
        first.versions[name],
        "changes.list reports the guard's version",
      );
      await ctx.client.blocksApply({
        set: { [name]: { v: 2 } },
        ifMatch: { [name]: listed!.version },
      });
      assertEqual((await list(ctx)).blocks[name], { v: 2 }, "the guarded save landed");
    },
  },
  {
    id: "overlay/if-match-base",
    title: "an entry only the base has is not in the overlay: ifMatch null saves it",
    async run(ctx) {
      await overlay(ctx);
      const base = await baseEntry(ctx);
      try {
        const modified = { ...base.value, conformance: ctx.prefix };
        const applied = await ctx.client.blocksApply({
          set: { [base.name]: modified },
          ifMatch: { [base.name]: null },
        });
        const listed = (await changes(ctx)).changes[base.name];
        assertEqual(listed?.kind, "set", "the saved base entry is a change");
        assertEqual(listed?.version, applied.versions[base.name], "with the saved version");
        await expectError(
          ctx.client.blocksApply({
            set: { [base.name]: base.value },
            ifMatch: { [base.name]: null },
          }),
          ErrorCode.Conflict,
          "ifMatch null once the overlay holds the entry",
        );
      } finally {
        await ctx.client.changesDiscard({ names: [base.name] }).catch(() => {});
      }
    },
  },
  {
    id: "overlay/own-entries",
    title: "changes.list lists every entry the overlay holds, even one equal to the base",
    async run(ctx) {
      await overlay(ctx);
      const base = await baseEntry(ctx);
      try {
        const applied = await ctx.client.blocksApply({ set: { [base.name]: base.value } });
        const listed = (await changes(ctx)).changes[base.name];
        assertEqual(
          listed?.kind,
          "set",
          "an entry saved with the base's value is still the overlay's",
        );
        assertEqual(listed?.version, applied.versions[base.name], "with the saved version");
        await ctx.client.changesDiscard({ names: [base.name] });
        assert(!(base.name in (await changes(ctx)).changes), "a discard drops it from the overlay");
        assertEqual((await list(ctx)).blocks[base.name], base.value, "the base shows through");
      } finally {
        await ctx.client.changesDiscard({ names: [base.name] }).catch(() => {});
      }
    },
  },
  {
    id: "overlay/delete-base",
    title: "deleting an entry only the base has records the deletion over the base",
    async run(ctx) {
      await overlay(ctx);
      const base = await baseEntry(ctx);
      try {
        const deleted = await ctx.client.blocksApply({ delete: [base.name] });
        assertEqual(deleted.versions, { [base.name]: null }, "the deleted entry's version");
        assert(!(base.name in (await list(ctx)).blocks), "the entry is gone from blocks.list");
        assertEqual((await changes(ctx)).changes[base.name]?.kind, "delete", "a delete change");
      } finally {
        await ctx.client.changesDiscard({ names: [base.name] }).catch(() => {});
      }
      assertEqual((await list(ctx)).blocks[base.name], base.value, "a discard brings it back");
    },
  },
];
