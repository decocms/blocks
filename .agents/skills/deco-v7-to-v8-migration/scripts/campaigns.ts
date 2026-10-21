/**
 * Campaign dates (spec: /next/built-in-blocks#date-windows). v7 wrote each
 * date window into its rule (`website/matchers/date.ts`, `{ start, end }`),
 * and so did early v8 content (`date { start, end }`); the next major keeps
 * every window in the saved block `campaigns`, of the built-in type
 * `date-windows` (each campaign's name → `{ start?, end? }`), and the built-in
 * rule `date` names one (`{ campaign }`). `date-windows` is the only place
 * date logic lives.
 *
 * - Each saved date matcher `N` becomes `campaigns[N]`, its window; every
 *   rule that pointed at it becomes `{ "__resolveType": "date", "campaign":
 *   N }`, and the saved matcher is deleted.
 * - Every inline date rule, v7's or v8's, becomes a campaign named after its
 *   window (`2026-11-27 → 2026-12-01`, `from 2026-11-27`, `until 2026-12-01`),
 *   which editors can rename in the site editor. Identical windows share one
 *   entry (a campaign already saved with that window included); two different
 *   windows with one name get a suffix (`… (2)`).
 * - The window's strings are kept as written, offset and all, so every rule
 *   switches at the moment it did before.
 *
 * It only adds: every campaign already saved is kept, and a second run finds
 * no inline date rule and changes nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { blockFileName, serializeBlock } from "@decocms/blocks/protocol/keys";
import type { Report } from "./report";
import { forEachBlock, isPlainObject, type JsonObject, readContent, savedNameClash } from "./walk";

/** The date rule, under the next major's name and the v7 names ./legacyNames.ts renames. */
const DATE_TYPES = new Set(["date", "website/matchers/date.ts", "$live/matchers/MatchDate.ts"]);

const CAMPAIGNS_BLOCK = "campaigns";
const CAMPAIGNS_TYPE = "date-windows";
const DATE_RULE = "date";

/** One campaign's window: ISO date-times, either bound open when absent. */
interface Window {
  start?: string;
  end?: string;
}

/** A date rule that still carries its own window rather than naming a campaign. */
function isInlineDate(node: JsonObject & { __resolveType: string }): boolean {
  return DATE_TYPES.has(node.__resolveType) && typeof node.campaign !== "string";
}

/**
 * The window a date rule (or a saved campaign) holds, or `null` when a bound
 * isn't a string, which no campaign can carry. An empty bound is open.
 */
function windowOf(node: unknown): Window | null {
  if (!isPlainObject(node)) return null;
  const window: Window = {};
  for (const key of ["start", "end"] as const) {
    const value = node[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") return null;
    window[key] = value;
  }
  return window;
}

const sameWindow = (a: Window, b: Window) => a.start === b.start && a.end === b.end;

/** The day a bound names, as written (`2026-11-27T00:00:00-03:00` → `2026-11-27`). */
const day = (bound: string) => /^\d{4}-\d{2}-\d{2}/.exec(bound.trim())?.[0] ?? bound.trim();

/** The name a migrated window gets: its days, which editors can rename. */
export function campaignName(window: Window): string {
  if (window.start !== undefined && window.end !== undefined) {
    return `${day(window.start)} → ${day(window.end)}`;
  }
  if (window.start !== undefined) return `from ${day(window.start)}`;
  if (window.end !== undefined) return `until ${day(window.end)}`;
  return "always";
}

/** Turns `node` into the `date` rule for `campaign`, in place. */
function becomeDate(node: JsonObject, campaign: string): void {
  for (const key of Object.keys(node)) delete node[key];
  node.__resolveType = DATE_RULE;
  node.campaign = campaign;
}

/**
 * Moves every date window into the saved block `campaigns` and points each
 * date rule at its campaign by name.
 */
export function migrateDateRules(root: string, report: Report): void {
  const blocksDir = path.join(root, ".deco", "blocks");
  const { blocks, files } = readContent(root);
  const saved = new Map<string, Window>();
  for (const [name, block] of Object.entries(blocks)) {
    if (
      name === CAMPAIGNS_BLOCK ||
      !isInlineDate(block as JsonObject & { __resolveType: string })
    ) {
      continue;
    }
    const window = windowOf(block);
    if (window) saved.set(name, window);
  }
  const inline: JsonObject[] = [];
  for (const [entry, block] of Object.entries(blocks)) {
    if (saved.has(entry) || entry === CAMPAIGNS_BLOCK) continue;
    forEachBlock(block, (node) => {
      if (isInlineDate(node)) inline.push(node);
    });
  }
  if (saved.size === 0 && inline.length === 0) return;

  const existing = blocks[CAMPAIGNS_BLOCK];
  const clash =
    existing && existing.__resolveType !== CAMPAIGNS_TYPE
      ? CAMPAIGNS_BLOCK
      : savedNameClash(blocks, CAMPAIGNS_BLOCK);
  if (clash !== undefined) {
    report.manual.push({
      step: "content",
      subject: files[clash],
      message: `"${CAMPAIGNS_BLOCK}" is the saved block every date rule reads (type "${CAMPAIGNS_TYPE}"), and "${clash}" takes that name${clash === CAMPAIGNS_BLOCK ? "" : " on a case-insensitive disk"}, so the date rules weren't moved: rename this block, then move each date window into "${CAMPAIGNS_BLOCK}" (a name → { start, end }) and point its rules at { "__resolveType": "date", "campaign": … } (/next/built-in-blocks#date-windows)`,
    });
    return;
  }

  // Every campaign already saved is kept as is: this only adds.
  const campaigns: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (key !== "__resolveType") campaigns[key] = value;
  }
  const added: string[] = [];
  /** `name`, or `name (2)`, … : the first one free or already holding `window`. */
  const place = (name: string, window: Window): string => {
    let candidate = name;
    for (let i = 2; ; i++) {
      if (!(candidate in campaigns)) {
        campaigns[candidate] = { ...window };
        added.push(candidate);
        return candidate;
      }
      const held = windowOf(campaigns[candidate]);
      if (held && sameWindow(held, window)) return candidate;
      candidate = `${name} (${i})`;
    }
  };
  /** A campaign that already has `window`, the saved matchers' first. */
  const holding = (window: Window): string | undefined =>
    Object.keys(campaigns).find((name) => {
      const held = windowOf(campaigns[name]);
      return held !== null && sameWindow(held, window);
    });

  const savedName = new Map<string, string>();
  for (const [name, window] of [...saved].sort(([a], [b]) => (a < b ? -1 : 1))) {
    savedName.set(name, place(name, window));
  }
  const windows: Window[] = [];
  const unmovable = new Set<string>();
  for (const node of inline) {
    const window = windowOf(node);
    if (window && !windows.some((w) => sameWindow(w, window))) windows.push(window);
  }
  windows.sort((a, b) => {
    const [x, y] = [campaignName(a), campaignName(b)];
    if (x !== y) return x < y ? -1 : 1;
    return `${a.start}|${a.end}` < `${b.start}|${b.end}` ? -1 : 1;
  });
  const inlineName = windows.map((w) => ({
    window: w,
    name: holding(w) ?? place(campaignName(w), w),
  }));
  const nameOf = (window: Window) => inlineName.find((n) => sameWindow(n.window, window))!.name;

  const changed = new Set<string>();
  for (const [entry, block] of Object.entries(blocks)) {
    if (saved.has(entry) || entry === CAMPAIGNS_BLOCK) continue;
    const rules = new Set<string>();
    forEachBlock(block, (node) => {
      if (savedName.has(node.__resolveType)) {
        const name = savedName.get(node.__resolveType)!;
        rules.add(name);
        becomeDate(node, name);
      } else if (isInlineDate(node)) {
        const window = windowOf(node);
        if (!window) {
          unmovable.add(entry);
          return;
        }
        const name = nameOf(window);
        rules.add(name);
        becomeDate(node, name);
      }
    });
    if (rules.size > 0) {
      changed.add(entry);
      report.done.push({
        step: "content",
        subject: files[entry],
        message: `date rules → campaigns (${[...rules]
          .sort()
          .map((n) => `"${n}"`)
          .join(", ")})`,
      });
    }
  }
  for (const entry of changed) {
    fs.writeFileSync(path.join(blocksDir, files[entry]), serializeBlock(blocks[entry]));
  }
  for (const [name, campaign] of [...savedName].sort(([a], [b]) => (a < b ? -1 : 1))) {
    fs.rmSync(path.join(blocksDir, files[name]));
    report.done.push({
      step: "content",
      subject: files[name],
      message: `deleted: the date matcher is now the campaign "${campaign}" in ${CAMPAIGNS_BLOCK}`,
    });
  }
  if (added.length > 0) {
    const file = files[CAMPAIGNS_BLOCK] ?? blockFileName(CAMPAIGNS_BLOCK);
    fs.writeFileSync(
      path.join(blocksDir, file),
      serializeBlock({ __resolveType: CAMPAIGNS_TYPE, ...campaigns }),
    );
    report.done.push({
      step: "content",
      subject: file,
      message: `the campaigns (${added.map((n) => `"${n}"`).join(", ")}): each window as it was written, so every rule switches at the same moment; a campaign named after its dates can be renamed in the site editor, which rewrites its rules`,
    });
  }
  for (const entry of [...unmovable].sort()) {
    report.manual.push({
      step: "content",
      subject: files[entry],
      message: `a date rule here has a start or end that isn't a date string, so it stayed inline and is always false: save its window in "${CAMPAIGNS_BLOCK}" and write { "__resolveType": "date", "campaign": … } (/next/built-in-blocks#date-windows)`,
    });
  }
}
