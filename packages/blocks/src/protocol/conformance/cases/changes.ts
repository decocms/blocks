/**
 * `changes.list`, `changes.get` and `changes.discard` (protocol 1.1): what
 * differs from the base, both sides of an entry, and dropping a change back
 * to the base. The suite only reasons about its own names, plus the
 * harness's `baseEntry` (which it always puts back), so other content on the
 * endpoint doesn't matter.
 */
import { ErrorCode } from "../../errors.ts";
import { MAX_NAMES_PER_GET } from "../../server/core.ts";
import type { BlocksListResult, ChangesListResult } from "../../types.ts";
import { REQUIRED_PROTOCOL_MINOR } from "../../types.ts";
import {
  assert,
  assertEqual,
  type ConformanceContext,
  expectError,
  rawErrorCode,
} from "../context.ts";
import type { ConformanceCase } from "./types.ts";

type FullChanges = Extract<ChangesListResult, { notModified: false }>;
type FullList = Extract<BlocksListResult, { notModified: false }>;

async function changes(ctx: ConformanceContext): Promise<FullChanges> {
  const result = await ctx.client.changesList();
  assert(!result.notModified, "an unconditional changes.list returns the changes");
  return result;
}

async function list(ctx: ConformanceContext): Promise<FullList> {
  const result = await ctx.client.blocksList();
  assert(!result.notModified, "an unconditional list returns the map");
  return result;
}

async function writable(ctx: ConformanceContext) {
  const d = await ctx.describe();
  if (d.readOnly) return ctx.skip("read-only endpoint");
  return d;
}

/** The harness's base entry, unchanged, with its current value and version. */
async function baseEntry(ctx: ConformanceContext) {
  await writable(ctx);
  const name = ctx.options.baseEntry?.name;
  if (name === undefined) return ctx.skip("no baseEntry");
  const blocks = await list(ctx);
  assert(name in blocks.blocks, `the baseEntry "${name}" exists`);
  const before = await changes(ctx);
  assert(!(name in before.changes), `the baseEntry "${name}" starts unchanged`);
  return { name, value: blocks.blocks[name]!, version: blocks.versions[name]! };
}

const req = (id: number, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: params ?? {},
});

export const changesCases: ConformanceCase[] = [
  {
    id: "changes/version",
    title: "the endpoint speaks protocol 1.1 or newer and knows the three changes methods",
    async run(ctx) {
      const d = await ctx.describe();
      assert(
        d.version.major === 1 && d.version.minor >= REQUIRED_PROTOCOL_MINOR,
        `describe reports ${d.version.major}.${d.version.minor}`,
      );
      const response = await ctx.rpc([
        req(1, "changes.list"),
        req(2, "changes.get", { names: [] }),
        req(3, "changes.discard", { names: [] }),
      ]);
      const bodies = response.body as unknown[];
      assert(Array.isArray(bodies) && bodies.length === 3, "three responses");
      for (const body of bodies) {
        assert(
          rawErrorCode(body) !== ErrorCode.MethodNotFound,
          `a changes method answered Method not found: ${JSON.stringify(body)}`,
        );
      }
    },
  },
  {
    id: "changes/list",
    title: "changes.list reports the base and a revision that answers ifNoneMatch",
    async run(ctx) {
      const first = await changes(ctx);
      assert(typeof first.revision === "string" && first.revision.length > 0, "a revision");
      assert(typeof first.base?.revision === "string", "base.revision is a string");
      assert(
        first.base.resolvedRef === null || typeof first.base.resolvedRef === "string",
        "base.resolvedRef is a string or null",
      );
      assert(typeof first.changes === "object" && first.changes !== null, "a changes map");
      for (const [name, change] of Object.entries(first.changes)) {
        assert(change.kind === "set" || change.kind === "delete", `${name}: kind`);
        if (change.kind === "delete") assertEqual(change.version, null, `${name}: version`);
        else assert(typeof change.version === "string", `${name}: a version`);
      }
      const poll = await ctx.client.changesList({ ifNoneMatch: first.revision });
      assert(poll.notModified, "polling with the returned revision is 'not modified'");
      assertEqual(poll.revision, first.revision, "the same revision");
      assertEqual(poll.base, first.base, "'not modified' carries the base");
      if ((await ctx.describe()).readOnly) return;
      await ctx.client.blocksApply({ set: { [ctx.name("moves")]: { v: 1 } } });
      const moved = await ctx.client.changesList({ ifNoneMatch: first.revision });
      assert(!moved.notModified, "a write moves the changes' revision");
    },
  },
  {
    id: "changes/create-and-discard",
    title: "a new entry is a set change with no base version; discarding it deletes it",
    async run(ctx) {
      await writable(ctx);
      const name = ctx.name("new");
      const value = { __resolveType: "hero", title: "Olá" };
      const applied = await ctx.client.blocksApply({ set: { [name]: value } });
      const listed = (await changes(ctx)).changes[name];
      assertEqual(
        listed,
        { kind: "set", version: applied.versions[name], baseVersion: null },
        "the listed change",
      );

      const detail = await ctx.client.changesGet({ names: [name] });
      assertEqual(
        detail.entries[name],
        {
          kind: "set",
          before: null,
          after: value,
          version: applied.versions[name],
          baseVersion: null,
        },
        "both sides of the new entry",
      );
      assertEqual(detail.diagnostics, [], "no diagnostics");

      const discarded = await ctx.client.changesDiscard({
        names: [name],
        ifMatch: { [name]: applied.versions[name]! },
      });
      assertEqual(discarded.versions[name], null, "a discarded new entry's version is null");
      const after = await list(ctx);
      assert(!(name in after.blocks), "the entry is gone from blocks.list");
      assertEqual(after.revision, discarded.revision, "the result's revision is blocks.list's");
      assert(!(name in (await changes(ctx)).changes), "the entry is no longer a change");
    },
  },
  {
    id: "changes/discard-conflict",
    title: "a discard whose ifMatch fails is a Conflict and changes nothing",
    async run(ctx) {
      await writable(ctx);
      const name = ctx.name("guarded");
      const first = await ctx.client.blocksApply({ set: { [name]: { v: 1 } } });
      const second = await ctx.client.blocksApply({ set: { [name]: { v: 2 } } });
      const error = await expectError(
        ctx.client.changesDiscard({ names: [name], ifMatch: { [name]: first.versions[name]! } }),
        ErrorCode.Conflict,
        "a stale ifMatch",
      );
      assertEqual(
        (error.data as { entries?: unknown })?.entries,
        { [name]: { expected: first.versions[name], actual: second.versions[name] } },
        "the conflict's entries",
      );
      const after = await list(ctx);
      assertEqual(after.blocks[name], { v: 2 }, "nothing was discarded");
      await expectError(
        ctx.client.changesDiscard({ names: [name], ifMatch: { [name]: null } }),
        ErrorCode.Conflict,
        "ifMatch null on an entry that exists",
      );
    },
  },
  {
    id: "changes/discard-noop",
    title: "discarding a name without a change, or no names, writes nothing",
    async run(ctx) {
      await writable(ctx);
      const name = ctx.name("absent");
      const before = await list(ctx);
      const none = await ctx.client.changesDiscard({ names: [] });
      assertEqual(none.versions, {}, "no names, no versions");
      assertEqual(none.revision, before.revision, "the revision is unchanged");
      const absent = await ctx.client.changesDiscard({ names: [name] });
      assertEqual(absent.versions, { [name]: null }, "an absent entry's version is null");
      assertEqual((await list(ctx)).revision, before.revision, "nothing was written");
    },
  },
  {
    id: "changes/get-params",
    title: "changes.get leaves out unknown names and refuses bad params",
    async run(ctx) {
      const unknown = await ctx.client.changesGet({ names: [ctx.name("nowhere")] });
      assertEqual(unknown.entries, {}, "an unknown name is absent");
      assert(typeof unknown.base?.revision === "string", "the base is reported");
      for (const params of [
        {},
        { names: "x" },
        { names: [""] },
        { names: [], extra: true },
        { name: "x" },
      ]) {
        const response = await ctx.rpc(req(1, "changes.get", params));
        assertEqual(
          rawErrorCode(response.body),
          ErrorCode.InvalidParams,
          `changes.get(${JSON.stringify(params)})`,
        );
      }
      const many = Array.from({ length: MAX_NAMES_PER_GET + 1 }, (_, i) => `${ctx.prefix}-${i}`);
      await expectError(
        ctx.client.changesGet({ names: many }),
        ErrorCode.LimitExceeded,
        "more names than changes.get takes",
      );
      const discard = await ctx.rpc(req(2, "changes.discard", { names: [], force: true }));
      assertEqual(rawErrorCode(discard.body), ErrorCode.InvalidParams, "an unknown discard param");
    },
  },
  {
    id: "changes/batch",
    title: "changes calls batch like any other method, results in order",
    async run(ctx) {
      const outcomes = await ctx.client.batch([
        { method: "changes.list" },
        { method: "changes.get", params: { names: [ctx.name("x")] } },
        { method: "blocks.list" },
      ]);
      assert(
        outcomes.every((o) => o.ok),
        "every call succeeds",
      );
      assert(
        typeof (outcomes[0] as { result: { base?: unknown } }).result.base === "object",
        "the first result is changes.list's",
      );
      assert(
        "entries" in (outcomes[1] as { result: object }).result,
        "the second is changes.get's",
      );
      assert("blocks" in (outcomes[2] as { result: object }).result, "the third is blocks.list's");
    },
  },
  {
    id: "changes/read-only",
    title: "a read-only endpoint lists and reads changes but refuses a discard",
    async run(ctx) {
      const d = await ctx.describe();
      if (!d.readOnly) return ctx.skip("writable endpoint");
      await changes(ctx);
      await ctx.client.changesGet({ names: [ctx.name("x")] });
      await expectError(
        ctx.client.changesDiscard({ names: [ctx.name("x")] }),
        ErrorCode.ReadOnly,
        "a discard on a read-only endpoint",
      );
    },
  },
  {
    id: "changes/base-modify",
    title: "a modified base entry shows both sides; a discard restores it",
    async run(ctx) {
      const base = await baseEntry(ctx);
      const modified = { ...base.value, conformance: ctx.prefix };
      try {
        const applied = await ctx.client.blocksApply({ set: { [base.name]: modified } });
        const listed = (await changes(ctx)).changes[base.name];
        assert(listed !== undefined, "the modified entry is listed");
        assertEqual(listed!.kind, "set", "kind");
        assertEqual(listed!.version, applied.versions[base.name], "version");
        assert(typeof listed!.baseVersion === "string", "a base version");

        const detail = (await ctx.client.changesGet({ names: [base.name] })).entries[base.name];
        assertEqual(detail?.before, base.value, "before is the base");
        assertEqual(detail?.after, modified, "after is the modified entry");

        const discarded = await ctx.client.changesDiscard({
          names: [base.name],
          ifMatch: { [base.name]: applied.versions[base.name]! },
        });
        assert(typeof discarded.versions[base.name] === "string", "a version after the discard");
        const after = await list(ctx);
        assertEqual(after.blocks[base.name], base.value, "the base value is back");
        assertEqual(after.versions[base.name], discarded.versions[base.name], "the listed version");
        assert(!(base.name in (await changes(ctx)).changes), "no longer a change");
      } finally {
        await ctx.client.changesDiscard({ names: [base.name] }).catch(() => {});
      }
    },
  },
  {
    id: "changes/base-delete",
    title: "a deleted base entry is a delete change; a discard brings it back",
    async run(ctx) {
      const base = await baseEntry(ctx);
      try {
        await ctx.client.blocksApply({ delete: [base.name] });
        const listed = (await changes(ctx)).changes[base.name];
        assert(listed !== undefined, "the deleted entry is listed");
        assertEqual(listed!.kind, "delete", "kind");
        assertEqual(listed!.version, null, "version");
        assert(typeof listed!.baseVersion === "string", "a base version");

        const detail = (await ctx.client.changesGet({ names: [base.name] })).entries[base.name];
        assertEqual(detail?.after, null, "after is null");
        assertEqual(detail?.before, base.value, "before is the base");

        await ctx.client.changesDiscard({ names: [base.name], ifMatch: { [base.name]: null } });
        const after = await list(ctx);
        assertEqual(after.blocks[base.name], base.value, "the entry is back");
        assert(!(base.name in (await changes(ctx)).changes), "no longer a change");
      } finally {
        await ctx.client.changesDiscard({ names: [base.name] }).catch(() => {});
      }
    },
  },
  {
    id: "changes/unchanged-entry",
    title: "changes.get on an unchanged entry answers kind null with equal sides",
    async run(ctx) {
      const base = await baseEntry(ctx);
      const detail = (await ctx.client.changesGet({ names: [base.name] })).entries[base.name];
      assertEqual(
        detail,
        {
          kind: null,
          before: base.value,
          after: base.value,
          version: base.version,
          baseVersion: base.version,
        },
        "an unchanged entry",
      );
    },
  },
  {
    id: "changes/empty-base",
    title: "with an empty base, every entry is a new set change",
    async run(ctx) {
      if (!ctx.options.emptyBase) return ctx.skip("the base isn't empty");
      await writable(ctx);
      const name = ctx.name("fresh");
      await ctx.client.blocksApply({ set: { [name]: { v: 1 } } });
      const all = await changes(ctx);
      const blocks = await list(ctx);
      for (const entry of Object.keys(blocks.blocks)) {
        assertEqual(all.changes[entry]?.kind, "set", `${entry} is a set change`);
        assertEqual(all.changes[entry]?.baseVersion, null, `${entry} has no base version`);
      }
      const detail = (await ctx.client.changesGet({ names: [name] })).entries[name];
      assertEqual(detail?.before, null, "no base side");
      await ctx.client.changesDiscard({ names: [name] });
      assert(!(name in (await list(ctx)).blocks), "discarding deletes it");
    },
  },
];
