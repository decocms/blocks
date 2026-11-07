/**
 * Redirects (spec: routing › Redirects): v8 routes the rules of one saved
 * block, `Redirects`, of the built-in type `redirects`; it routes no v7
 * redirect block. This step folds every v7 one into `Redirects`:
 *
 * - a per-rule `website/loaders/redirect.ts` block,
 *   `{ redirect: { from, to, type?, discardQueryParameters? } }`;
 * - a list `website/loaders/redirects.ts` block,
 *   `{ redirects: [{ from, to, type?, discardQueryParameters? }] }`;
 * - a list `deco-sites/std/loaders/x/redirects.ts` block, the same shape;
 * - a `website/loaders/redirectsFromCsv.ts` loader, saved or inline in another
 *   block (`site.routes`), `{ from: "static/redirects.csv",
 *   forcePermanentRedirects? }`: the rows of its CSV file.
 *
 * These are what 7.x routed: `loadRedirects` in 7.x's `sdk/redirects.ts`
 * reads `redirects` or `redirect` from any saved block of the first three
 * types (and of the CSV type), and 7.x's build (`buildCsvRedirectBlocks`)
 * read every CSV loader, saved or nested anywhere, from the site's `public/`
 * (`static/x.csv`, `public/x.csv`, `/x.csv` or `x.csv` all name
 * `public/x.csv`, and `../x.csv` the site's `x.csv`). A CSV is parsed as 7.x's `parseRedirectsCsv` did: one rule
 * a line, `from,to` then `type` (`permanent`, `301` or `temporary`) and
 * `discardQueryParameters` (`true` or `false`) recognized by value in any
 * later column; fields split on `,` (and on `;` outside quotes); blank lines,
 * `#` comments and a `from,to` header row skipped; a row with no type is
 * temporary, or permanent under the loader's `forcePermanentRedirects` (any
 * loader of the same file setting it). 7.x loaded the CSV rows before the
 * saved blocks.
 *
 * Each rule becomes `{ from, to, permanent }` (v7's `type: "permanent"` or
 * `"301"` is `permanent: true`, a 301; anything else, `temporary` or none, is
 * `permanent: false`, a 307 in v8), `from` and `to` trimmed as v7 read them
 * (an absolute `from`, `https://store.com/x`, is its path, as 7.x matched
 * it), with `discardQueryParameters` kept. Rules are deduped by `from`, in
 * 7.x's load order: the CSV rows, file by file in the order the loaders are
 * found, then the v7 blocks in code-unit name order, each in its own order.
 * For one exact `from` the last rule wins, as in 7.x's exact map (a later
 * block, a later row; so a saved block's rule wins over a CSV row); for a
 * glob (a `*` in `from`) the first wins, as 7.x scanned its patterns in
 * order. An existing `Redirects` block's rules come first and always win
 * (they are v8's already). Every rule that loses to one sending its route
 * somewhere else is reported. The v7 blocks and
 * the CSV loaders are deleted once folded (the CSV files are kept, and
 * reported); a second run changes nothing.
 *
 * A v7 redirect written inline in another block (not a saved block of its
 * own) is reported, not folded: v7 routed only saved blocks. A CSV loader
 * whose file 7.x couldn't read (a URL, a path outside the site, a missing
 * file) is left as it is and reported: 7.x routed none of its rows (a saved
 * one's own `redirects`, which 7.x routed, are named in the report).
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
/** v7's CSV redirects loader: its rules live in a CSV file under `public/`. */
export const V7_CSV_REDIRECTS_TYPE = "website/loaders/redirectsFromCsv.ts";
const ROUTING_DOC = "/next/routing#redirects";

/** A v8 rule, as the `redirects` built-in stores it. */
interface Rule {
  from: string;
  to: string;
  permanent: boolean;
  discardQueryParameters?: boolean;
}

/** An absolute source as the path 7.x matched (`sourcePath`): origin dropped, query kept. */
function sourcePath(from: string): string {
  if (!from.startsWith("http://") && !from.startsWith("https://")) return from;
  try {
    const url = new URL(from);
    return url.pathname + url.search;
  } catch {
    const slash = from.indexOf("/", from.indexOf("//") + 2);
    return slash >= 0 ? from.slice(slash) : from;
  }
}

/** A v7 rule (`{ from, to, type? }`) as a v8 rule; null when it has no string `from`/`to`. */
function fromV7(rule: unknown): Rule | null {
  if (!isPlainObject(rule)) return null;
  // A list rule saved in the per-rule shape, `{ redirect: { … } }`, reads the same.
  const flat = isPlainObject(rule.redirect) ? rule.redirect : rule;
  const { type, discardQueryParameters } = flat;
  // Trimmed, as v7 read them; v7's `isPermanent` takes "301" too.
  const from = typeof flat.from === "string" ? sourcePath(flat.from.trim()) : "";
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

// ---------------------------------------------------------------------------
// CSV files, read as 7.x read them
// ---------------------------------------------------------------------------

const TYPE_VALUES = ["temporary", "permanent", "301"];
const DISCARD_VALUES = ["true", "false"];
/** 7.x's (and Fresh's) field split: a comma always splits; a semicolon only outside quotes. */
const FIELD_SPLIT = /,|;(?=(?:(?:[^"]*"){2})*[^"]*$)/;

/** Removes and returns the first field that is one of `values`. */
function takeValue(fields: string[], values: string[]): string | null {
  const index = fields.findIndex((field) => values.includes(field));
  return index === -1 ? null : fields.splice(index, 1)[0]!;
}

/**
 * The rows of a CSV as v7 rules, `{ from, to, type, discardQueryParameters? }`,
 * and how many lines have no `from` and `to` (7.x skipped them). Blank lines,
 * `#` comments and a `from,to` header row aren't rows.
 */
function parseRedirectsCsv(
  csv: string,
  forcePermanentRedirects: boolean,
): { rows: JsonObject[]; skipped: number } {
  const rows: JsonObject[] = [];
  let skipped = 0;
  for (const raw of csv.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(FIELD_SPLIT).map((field) => field.trim());
    const type =
      takeValue(fields, TYPE_VALUES) ?? (forcePermanentRedirects ? "permanent" : "temporary");
    const discard = takeValue(fields, DISCARD_VALUES) === "true";
    const [from, to] = fields;
    if (!from || !to) {
      skipped += 1;
      continue;
    }
    // A header row, once or repeated where files were concatenated.
    if (from.toLowerCase() === "from" && to.toLowerCase() === "to") continue;
    rows.push({ from, to, type, ...(discard ? { discardQueryParameters: true } : {}) });
  }
  return { rows, skipped };
}

/**
 * A CSV loader's file, as 7.x resolved it (`path.resolve(public, from)` once
 * a leading `static/`, `public/` or `/` is dropped, so `../x.csv` is the
 * site's `x.csv`), or why 7.x couldn't read it.
 */
function csvFile(root: string, from: unknown): { file: string } | { problem: string } {
  if (typeof from !== "string" || from.trim() === "") return { problem: "it names no file" };
  const written = from.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(written)) {
    return { problem: `${written} is a URL, which 7.x never fetched (it read only files)` };
  }
  const relative = written.replace(/^\/?(?:static|public)\//i, "").replace(/^\//, "");
  const full = path.resolve(root, "public", relative);
  const inside = path.relative(root, full);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    return { problem: `${written} names ${full}, outside the site` };
  }
  const file = inside.split(path.sep).join("/");
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return { problem: `${file} (from ${written}) doesn't exist` };
  }
  return { file };
}

/** A CSV loader found in the content: in a saved block, or the saved block itself. */
interface CsvLoader {
  /** The saved block holding it. */
  block: string;
  /** The loader is the saved block itself, not inline in it. */
  saved: boolean;
  node: JsonObject;
  /** The CSV file it reads (`public/…`), or why it can't be read. */
  file?: string;
  problem?: string;
}

/** Removes every object in `value` that `drop` picks, from its array or its key; true when one was. */
function removeNodes(value: unknown, drop: (node: JsonObject) => boolean): boolean {
  let removed = false;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      if (isPlainObject(value[i]) && drop(value[i] as JsonObject)) {
        value.splice(i, 1);
        removed = true;
      } else if (removeNodes(value[i], drop)) removed = true;
    }
    return removed;
  }
  if (!isPlainObject(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (isPlainObject(child) && drop(child)) {
      delete value[key];
      removed = true;
    } else if (removeNodes(child, drop)) removed = true;
  }
  return removed;
}

export function foldRedirects(root: string, report: Report): void {
  const blocksDir = path.join(root, ".deco", "blocks");
  const { blocks, files } = readContent(root);
  const subject = (name: string) => `.deco/blocks/${files[name]}`;
  const names = Object.keys(blocks).sort(byCodeUnit);

  // Every CSV loader, saved or inline, in block name order, outermost first.
  const loaders: CsvLoader[] = [];
  for (const name of names) {
    forEachBlock(blocks[name], (node) => {
      if (node.__resolveType !== V7_CSV_REDIRECTS_TYPE) return;
      loaders.push({
        block: name,
        saved: node === blocks[name],
        node,
        ...csvFile(root, node.from),
      });
    });
  }
  for (const loader of loaders) {
    if (loader.problem === undefined) continue;
    // 7.x routed a saved loader's own `redirects` even when its file was missing.
    const own = loader.saved ? v7Rules(loader.node).length : 0;
    const routed =
      own > 0
        ? `, and the ${own === 1 ? "rule" : `${own} rules`} in its own "redirects", which 7.x routed`
        : "";
    report.manual.push({
      step: "content",
      subject: subject(loader.block),
      message: `holds a v7 CSV redirects loader (${V7_CSV_REDIRECTS_TYPE}) whose file wasn't read: ${loader.problem}. 7.x routed none of its rows; if the site needs them, add each row to the "${REDIRECTS_BLOCK}" block (type "${REDIRECTS_TYPE}"; a row typed permanent or 301, or one with no type under forcePermanentRedirects, is permanent: true)${routed}, then remove the loader (${ROUTING_DOC})`,
    });
  }
  const readable = loaders.filter((loader) => loader.file !== undefined);

  // v7 redirects inline in another block: reported, never folded.
  for (const name of names) {
    let inline = 0;
    for (const value of Object.values(blocks[name]!)) {
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

  // The saved blocks folded and deleted: the v7 redirect blocks, and each
  // saved CSV loader whose file is read (7.x routed its own `redirects` too).
  const sources = names.filter((name) => {
    const type = blocks[name]!.__resolveType as string;
    if (V7_TYPES.has(type)) return true;
    return readable.some((loader) => loader.saved && loader.block === name);
  });
  if (sources.length === 0 && readable.length === 0) return;

  const current = blocks[REDIRECTS_BLOCK];
  const currentIsV7 = current !== undefined && sources.includes(REDIRECTS_BLOCK);
  if (current !== undefined && !currentIsV7 && current.__resolveType !== REDIRECTS_TYPE) {
    const csvs = [...new Set(readable.map((loader) => loader.file!))];
    const waiting = [
      ...sources.map(subject),
      ...(csvs.length ? [`the CSV files ${csvs.join(", ")}`] : []),
    ];
    report.manual.push({
      step: "content",
      subject: subject(REDIRECTS_BLOCK),
      message: `"${REDIRECTS_BLOCK}" is the name of the redirects block (type "${REDIRECTS_TYPE}"); rename this "${String(current.__resolveType)}" block, then run the migration again to fold the v7 redirects (${waiting.join(", ")}) into it (${ROUTING_DOC})`,
    });
    return;
  }

  // An existing v8 Redirects block keeps its rules, first, and they win:
  // they are v8's already, which no v7 rule overrides.
  const existing: unknown[] =
    current !== undefined && !currentIsV7 && Array.isArray(current.redirects)
      ? [...current.redirects]
      : [];
  const pinned = new Map<string, unknown>();
  for (const rule of existing) {
    if (isPlainObject(rule) && typeof rule.from === "string" && !pinned.has(rule.from)) {
      pinned.set(rule.from, rule);
    }
  }

  /** The v7 rule kept for each `from`, where 7.x's route table put it. */
  const chosen = new Map<string, { rule: Rule; source: string; subject: string }>();
  const describe = (rule: Rule) => `to ${rule.to}, ${rule.permanent ? "permanent" : "temporary"}`;
  /**
   * Adds the v7 rules of one source, in 7.x's load order; returns how many
   * had no `from` and `to`. For one exact `from` the LAST rule wins, as
   * 7.x's exact map (`map.exact.set`) kept it; for a glob (a `*` in `from`)
   * the FIRST, as 7.x scanned its patterns in order. Each conflict is reported
   * on the rule that lost.
   */
  function fold(rules: unknown[], source: string, noteSubject: string): number {
    let skipped = 0;
    for (const v7 of rules) {
      const rule = fromV7(v7);
      if (rule === null) {
        skipped += 1;
        continue;
      }
      const v8 = pinned.get(rule.from);
      if (v8 !== undefined) {
        if (target(v8) !== target(rule)) {
          report.manual.push({
            step: "content",
            subject: noteSubject,
            message: `its rule for ${rule.from} (${describe(rule)}) conflicts with the one already in "${REDIRECTS_BLOCK}" (to ${String((v8 as JsonObject).to)}), which was kept: change it there if this one should win`,
          });
        }
        continue;
      }
      const earlier = chosen.get(rule.from);
      if (earlier === undefined) {
        chosen.set(rule.from, { rule, source, subject: noteSubject });
        continue;
      }
      if (target(earlier.rule) === target(rule)) continue;
      if (rule.from.includes("*")) {
        report.manual.push({
          step: "content",
          subject: noteSubject,
          message: `its rule for ${rule.from} (${describe(rule)}) conflicts with the earlier one from "${earlier.source}" (to ${earlier.rule.to}), which was kept in "${REDIRECTS_BLOCK}" as 7.x matched the first glob rule: change it there if this one should win`,
        });
        continue;
      }
      report.manual.push({
        step: "content",
        subject: earlier.subject,
        message: `its rule for ${rule.from} (${describe(earlier.rule)}) conflicts with the later one from "${source}" (to ${rule.to}), which was kept in "${REDIRECTS_BLOCK}" as 7.x routed the last rule for a path: change it there if this one should win`,
      });
      // The later rule takes the earlier one's place.
      chosen.set(rule.from, { rule, source, subject: noteSubject });
    }
    return skipped;
  }

  // 7.x's load order: the CSV files first, each once, in the order the
  // loaders are found (7.x spread them before the saved blocks, so a saved
  // block's exact rule wins over a CSV row), then the saved blocks in name order.
  const csvs = new Map<string, boolean>();
  for (const loader of readable) {
    const force = loader.node.forcePermanentRedirects === true;
    csvs.set(loader.file!, (csvs.get(loader.file!) ?? false) || force);
  }
  const csvRows = new Map<string, number>();
  for (const [file, force] of csvs) {
    const csv = fs.readFileSync(path.join(root, file), "utf8");
    const { rows, skipped } = parseRedirectsCsv(csv, force);
    csvRows.set(file, rows.length);
    const malformed = skipped + fold(rows, file, file);
    if (malformed > 0) {
      report.manual.push({
        step: "content",
        subject: file,
        message: `${malformed === 1 ? "a row" : `${malformed} rows`} without a from and a to, left out of "${REDIRECTS_BLOCK}", as 7.x skipped them`,
      });
    }
  }

  const folded: string[] = [];
  for (const name of sources) {
    const skipped = fold(v7Rules(blocks[name]!), name, subject(name));
    if (skipped > 0) {
      report.manual.push({
        step: "content",
        subject: subject(name),
        message: `${skipped === 1 ? "a rule" : `${skipped} rules`} without a from and a to, left out of "${REDIRECTS_BLOCK}" (the block was deleted; git has it)`,
      });
    }
    folded.push(files[name]!);
  }

  const rules = [...chosen.values()].map((entry) => entry.rule);
  const kept: unknown[] = [...existing, ...rules];
  const added = rules.length;
  const temporary = rules.filter((rule) => !rule.permanent).length;

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

  // Inline CSV loaders whose file was folded come out of the blocks holding them.
  const inline = new Set(readable.filter((loader) => !loader.saved).map((loader) => loader.node));
  for (const name of [...new Set(readable.filter((l) => !l.saved).map((l) => l.block))]) {
    if (sources.includes(name)) continue;
    const block = blocks[name]!;
    if (!removeNodes(block, (node) => inline.has(node))) continue;
    fs.writeFileSync(path.join(blocksDir, files[name]!), serializeBlock(block));
    const read = readable.filter((loader) => !loader.saved && loader.block === name);
    report.done.push({
      step: "content",
      subject: subject(name),
      message: `removed ${read.length === 1 ? "its v7 CSV redirects loader" : `its ${read.length} v7 CSV redirects loaders`} (${V7_CSV_REDIRECTS_TYPE}: ${[...new Set(read.map((l) => l.file))].join(", ")}): the rows are in "${REDIRECTS_BLOCK}"`,
    });
  }

  const from = [
    ...(folded.length ? [`the v7 redirect blocks ${folded.join(", ")}`] : []),
    ...(csvs.size ? [`the CSV files ${[...csvs.keys()].join(", ")}`] : []),
  ];
  const statuses = `v7's type permanent is permanent: true, a 301, and temporary permanent: false, a 307${temporary > 0 ? "; under 7.x's default (legacy) redirect semantics a temporary rule answered 302" : ""}`;
  report.done.push({
    step: "content",
    subject: `.deco/blocks/${file}`,
    message: `folded ${added === 1 ? "1 rule" : `${added} rules`} from ${from.join(" and ")}, then deleted ${folded.length ? "them" : "the loaders"}: v8 routes only this block (type "${REDIRECTS_TYPE}"; ${statuses}) (${ROUTING_DOC})`,
  });
  for (const [csv, rows] of csvRows) {
    report.manual.push({
      step: "content",
      subject: csv,
      message: `kept: v8 reads no CSV, and its ${rows === 1 ? "row is" : `${rows} rows are`} in the "${REDIRECTS_BLOCK}" block now. Delete the file once you've checked them there`,
    });
  }
}
