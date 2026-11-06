/**
 * Redirects (spec: routing › Redirects): v8 routes the rules of one saved
 * block, `Redirects`, of the built-in type `redirects`; it routes no v7
 * redirect block. This step folds every v7 one into `Redirects`:
 *
 * - a per-rule `website/loaders/redirect.ts` block,
 *   `{ redirect: { from, to, type?, discardQueryParameters? } }`;
 * - a list `website/loaders/redirects.ts` block,
 *   `{ redirects: [{ from, to, type?, discardQueryParameters? }] }`;
 * - a list `deco-sites/std/loaders/x/redirects.ts` block, the same shape.
 *
 * These are the saved block types v7 routed (`loadRedirects` in 7.x's
 * `sdk/redirects.ts`), which reads `redirects` or `redirect` from any of
 * them. Each rule becomes `{ from, to, permanent }` (v7's `type:
 * "permanent"` or `"301"` is `permanent: true`, a 301; anything else,
 * `temporary` or none, is `permanent: false`), `from` and `to` trimmed as v7
 * read them, with `discardQueryParameters` kept. Rules are deduped
 * by `from`: an existing `Redirects` block's rules come first, then the v7
 * blocks in code-unit name order, each in its own order, and the first rule
 * for a route wins; a later one that sends it somewhere else is reported.
 * The v7 blocks are deleted once folded; a second run changes nothing.
 *
 * A v7 redirect written inline in another block (not a saved block of its
 * own) is reported, not folded: v7 routed only saved blocks. So is every
 * `website/loaders/redirectsFromCsv.ts` loader, saved or inline: v7 read its
 * CSV at build time and v8 reads none, so its rows go into `Redirects` by hand.
 */
import fs from "node:fs";
import path from "node:path";
import { blockFileName, serializeBlock } from "@decocms/blocks/protocol/keys";
import type { Report } from "./report";
import { forEachBlock, isPlainObject, type JsonObject, readContent } from "./walk";

export const REDIRECTS_BLOCK = "Redirects";
export const REDIRECTS_TYPE = "redirects";
/** v7's per-rule redirect block type. */
export const V7_REDIRECT_TYPE = "website/loaders/redirect.ts";
/** v7's list-of-rules redirect block type. */
export const V7_REDIRECTS_TYPE = "website/loaders/redirects.ts";
/** The std app's list-of-rules redirect block type, which v7 routed too. */
export const V7_STD_REDIRECTS_TYPE = "deco-sites/std/loaders/x/redirects.ts";
const V7_TYPES = new Set([V7_REDIRECT_TYPE, V7_REDIRECTS_TYPE, V7_STD_REDIRECTS_TYPE]);
/** v7's CSV redirects loader: its rules live in a CSV file, not in content. */
export const V7_CSV_REDIRECTS_TYPE = "website/loaders/redirectsFromCsv.ts";
const ROUTING_DOC = "/next/routing#redirects";

/** A v8 rule, as the `redirects` built-in stores it. */
interface Rule {
  from: string;
  to: string;
  permanent: boolean;
  discardQueryParameters?: boolean;
}

/** A v7 rule (`{ from, to, type? }`) as a v8 rule; null when it has no string `from`/`to`. */
function fromV7(rule: unknown): Rule | null {
  if (!isPlainObject(rule)) return null;
  // A list rule saved in the per-rule shape, `{ redirect: { … } }`, reads the same.
  const flat = isPlainObject(rule.redirect) ? rule.redirect : rule;
  const { type, discardQueryParameters } = flat;
  // Trimmed, as v7 read them; v7's `isPermanent` takes "301" too.
  const from = typeof flat.from === "string" ? flat.from.trim() : "";
  const to = typeof flat.to === "string" ? flat.to.trim() : "";
  if (from === "" || to === "") return null;
  const out: Rule = { from, to, permanent: type === "permanent" || type === "301" };
  if (typeof discardQueryParameters === "boolean") {
    out.discardQueryParameters = discardQueryParameters;
  }
  return out;
}

/** The v7 rules a saved v7 redirect block holds, in order: `redirects ?? redirect`, as v7 read them. */
function v7Rules(block: JsonObject): unknown[] {
  const entries = block.redirects ?? block.redirect;
  if (entries === undefined || entries === null) return [];
  return Array.isArray(entries) ? entries : [entries];
}

/** Where a rule sends its route: what makes two rules for one `from` the same rule. */
function target(rule: unknown): string {
  if (!isPlainObject(rule)) return JSON.stringify(rule);
  return JSON.stringify([rule.to, rule.permanent === true, rule.discardQueryParameters === true]);
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function foldRedirects(root: string, report: Report): void {
  const blocksDir = path.join(root, ".deco", "blocks");
  const { blocks, files } = readContent(root);
  const subject = (name: string) => `.deco/blocks/${files[name]}`;

  const sources = Object.keys(blocks)
    .filter((name) => V7_TYPES.has(blocks[name]!.__resolveType as string))
    .sort(byCodeUnit);

  // v7 CSV redirects, saved or inline: v8 reads no CSV, so they're reported.
  for (const [name, block] of Object.entries(blocks)) {
    const csvs: string[] = [];
    forEachBlock(block, (node) => {
      if (node.__resolveType !== V7_CSV_REDIRECTS_TYPE) return;
      csvs.push(typeof node.from === "string" && node.from !== "" ? node.from : "(no from)");
    });
    if (csvs.length === 0) continue;
    report.manual.push({
      step: "content",
      subject: subject(name),
      message: `holds a v7 CSV redirects loader (${V7_CSV_REDIRECTS_TYPE}: ${csvs.join(", ")}), which v8 doesn't read: add each CSV row to the "${REDIRECTS_BLOCK}" block (type "${REDIRECTS_TYPE}"; a row typed permanent or 301, or one with no type under forcePermanentRedirects, is permanent: true) and remove the loader (${ROUTING_DOC})`,
    });
  }

  // v7 redirects inline in another block: reported, never folded.
  for (const [name, block] of Object.entries(blocks)) {
    let inline = 0;
    for (const value of Object.values(block)) {
      forEachBlock(value, (node) => {
        if (V7_TYPES.has(node.__resolveType)) inline += 1;
      });
    }
    if (inline === 0) continue;
    report.manual.push({
      step: "content",
      subject: subject(name),
      message: `holds ${inline === 1 ? "a v7 redirect" : `${inline} v7 redirects`} inline (${[...V7_TYPES].join(" or ")}), which v8 doesn't route: if v7 routed them, add their rules to the "${REDIRECTS_BLOCK}" block (type "${REDIRECTS_TYPE}") and remove them here (${ROUTING_DOC})`,
    });
  }
  if (sources.length === 0) return;

  const current = blocks[REDIRECTS_BLOCK];
  const currentIsV7 = current !== undefined && sources.includes(REDIRECTS_BLOCK);
  if (current !== undefined && !currentIsV7 && current.__resolveType !== REDIRECTS_TYPE) {
    report.manual.push({
      step: "content",
      subject: subject(REDIRECTS_BLOCK),
      message: `"${REDIRECTS_BLOCK}" is the name of the redirects block (type "${REDIRECTS_TYPE}"); rename this "${String(current.__resolveType)}" block, then run the migration again to fold the v7 redirect blocks (${sources.map(subject).join(", ")}) into it (${ROUTING_DOC})`,
    });
    return;
  }

  // An existing v8 Redirects block keeps its rules, first.
  const kept: unknown[] =
    current !== undefined && !currentIsV7 && Array.isArray(current.redirects)
      ? [...current.redirects]
      : [];
  const seen = new Map<string, { rule: unknown; source: string }>();
  for (const rule of kept) {
    if (isPlainObject(rule) && typeof rule.from === "string" && !seen.has(rule.from)) {
      seen.set(rule.from, { rule, source: REDIRECTS_BLOCK });
    }
  }

  const folded: string[] = [];
  let added = 0;
  for (const name of sources) {
    const rules = v7Rules(blocks[name]!);
    let skipped = 0;
    for (const v7 of rules) {
      const rule = fromV7(v7);
      if (rule === null) {
        skipped += 1;
        continue;
      }
      const first = seen.get(rule.from);
      if (first) {
        if (target(first.rule) !== target(rule)) {
          report.manual.push({
            step: "content",
            subject: subject(name),
            message: `its rule for ${rule.from} (to ${rule.to}, ${rule.permanent ? "permanent" : "temporary"}) conflicts with the one from "${first.source}" (to ${String((first.rule as JsonObject).to)}), which was kept in "${REDIRECTS_BLOCK}": change it there if this one should win`,
          });
        }
        continue;
      }
      seen.set(rule.from, { rule, source: name });
      kept.push(rule);
      added += 1;
    }
    if (skipped > 0) {
      report.manual.push({
        step: "content",
        subject: subject(name),
        message: `${skipped === 1 ? "a rule" : `${skipped} rules`} without a from and a to, left out of "${REDIRECTS_BLOCK}" (the block was deleted; git has it)`,
      });
    }
    folded.push(files[name]!);
  }

  fs.mkdirSync(blocksDir, { recursive: true });
  const file = files[REDIRECTS_BLOCK] ?? blockFileName(REDIRECTS_BLOCK);
  const next = serializeBlock({
    ...(currentIsV7 ? {} : current),
    __resolveType: REDIRECTS_TYPE,
    redirects: kept,
  });
  // Deleted first: on a case-insensitive disk, redirects.json is Redirects.json.
  for (const old of folded) {
    if (old !== file) fs.rmSync(path.join(blocksDir, old), { force: true });
  }
  const full = path.join(blocksDir, file);
  if (!fs.existsSync(full) || fs.readFileSync(full, "utf8") !== next) fs.writeFileSync(full, next);
  report.done.push({
    step: "content",
    subject: `.deco/blocks/${file}`,
    message: `folded ${added === 1 ? "1 rule" : `${added} rules`} from the v7 redirect blocks ${folded.join(", ")}, then deleted them: v8 routes only this block (type "${REDIRECTS_TYPE}"; v7's type permanent is permanent: true, a 301, and temporary permanent: false) (${ROUTING_DOC})`,
  });
}
