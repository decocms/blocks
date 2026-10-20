/**
 * A/B tests (spec: /next/built-in-blocks#experiments). v7 ran them on its
 * random matcher; the next major runs them on content: the built-in
 * `Experiments` block (each test's name → the whole percentage of visitors in
 * it) and the built-in `experiment` matcher (`{ name }`). The binding assigns
 * each visitor and owns the `deco_segment` cookie, so no v7 matcher writes it.
 *
 * - Each saved v7 random matcher `N` becomes `Experiments[N]`, its
 *   `round(traffic * 100)`; every rule that pointed at it becomes
 *   `{ "__resolveType": "experiment", "name": N }`, and the saved matcher is
 *   deleted. v7's sticky random (latest 7.x) kept the visitor's group in
 *   `deco_segment` under the saved name, and `assign` reads those groups back,
 *   so visitors stay in their groups.
 * - v7 kept every random rule written inline under one name, its type
 *   (`website/matchers/random.ts`). When they all have one traffic share they
 *   become one experiment of that name, which keeps the visitors' groups;
 *   otherwise each share becomes its own experiment, and the report says so.
 * - v7 keyed A/B results on the saved name of the random matcher a variant's
 *   rule pointed at; the next major keys them on `multivariate`'s
 *   `experiment`, so that name is copied there (one already set is kept).
 *
 * v7's date matchers stay inline rules (the built-in `date`, ./legacyNames.ts):
 * nothing moves to the `Schedules` block.
 */
import fs from "node:fs";
import path from "node:path";
import { LEGACY_ALIASES } from "@decocms/blocks/cli";
import { blockFileName, serializeBlock } from "@decocms/blocks/protocol/keys";
import { siteFramework } from "./framework";
import type { Report } from "./report";
import { forEachBlock, type JsonObject, readContent } from "./walk";

/** v7's random matcher, under each name v7 saved it with. */
const RANDOM_MATCHERS = new Set([
  "website/matchers/random.ts",
  "website/matchers/random",
  "$live/matchers/MatchRandom.ts",
]);

/** The name v7 kept inline random rules under in `deco_segment`. */
export const INLINE_EXPERIMENT = "website/matchers/random.ts";

const EXPERIMENTS_BLOCK = "Experiments";
const EXPERIMENTS_TYPE = "experiments";
const EXPERIMENT_MATCHER = "experiment";

function isMultivariate(type: string): boolean {
  return (
    type === "multivariate" ||
    (Object.hasOwn(LEGACY_ALIASES, type) && LEGACY_ALIASES[type] === "multivariate")
  );
}

/** v7's `traffic` (0–1, 0.5 when unset) as the whole percentage `Experiments` holds. */
export function trafficPercent(traffic: unknown): number {
  const share = typeof traffic === "number" && Number.isFinite(traffic) ? traffic : 0.5;
  return Math.min(100, Math.max(0, Math.round(share * 100)));
}

/** Turns `node` into the `experiment` rule for `name`, in place. */
function becomeExperiment(node: JsonObject, name: string): void {
  for (const key of Object.keys(node)) delete node[key];
  node.__resolveType = EXPERIMENT_MATCHER;
  node.name = name;
}

/**
 * Moves v7's random matchers into the `Experiments` block and `experiment`
 * rules, and copies each saved random matcher's name into the `experiment`
 * of the `multivariate` blocks whose variants point at it.
 */
export function migrateRandomMatchers(root: string, report: Report): void {
  const blocksDir = path.join(root, ".deco", "blocks");
  const { blocks, files } = readContent(root);
  const saved = new Map<string, number>();
  for (const [name, block] of Object.entries(blocks)) {
    if (RANDOM_MATCHERS.has(block.__resolveType as string)) {
      saved.set(name, trafficPercent(block.traffic));
    }
  }
  const inline: JsonObject[] = [];
  for (const [entry, block] of Object.entries(blocks)) {
    if (saved.has(entry)) continue;
    forEachBlock(block, (node) => {
      if (RANDOM_MATCHERS.has(node.__resolveType)) inline.push(node);
    });
  }
  if (saved.size === 0 && inline.length === 0) return;

  const existing = blocks[EXPERIMENTS_BLOCK];
  if (existing && existing.__resolveType !== EXPERIMENTS_TYPE) {
    report.manual.push({
      step: "content",
      subject: files[EXPERIMENTS_BLOCK],
      message: `"${EXPERIMENTS_BLOCK}" is the name of the built-in A/B tests block, so v7's random matchers weren't moved into it: rename this block, then move each random matcher into "${EXPERIMENTS_BLOCK}" (its name → round(traffic × 100)) and point its rules at { "__resolveType": "experiment", "name": … } (/next/built-in-blocks#experiments)`,
    });
    return;
  }
  const experiments: Record<string, number> = Object.create(null);
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (key !== "__resolveType" && typeof value === "number") experiments[key] = value;
  }
  const added: string[] = [];
  const add = (name: string, percent: number) => {
    if (!(name in experiments)) {
      experiments[name] = percent;
      added.push(name);
    }
  };
  for (const [name, percent] of [...saved].sort(([a], [b]) => (a < b ? -1 : 1))) {
    add(name, percent);
  }
  const inlineName = inlineNames(inline, experiments, add, report);

  const changed = new Set<string>();
  for (const [entry, block] of Object.entries(blocks)) {
    if (saved.has(entry) || entry === EXPERIMENTS_BLOCK) continue;
    forEachBlock(block, (node) => {
      if (!isMultivariate(node.__resolveType) || node.experiment !== undefined) return;
      const variants = Array.isArray(node.variants) ? node.variants : [];
      const name = variants
        .map((v) => (v as { rule?: { __resolveType?: unknown } } | null)?.rule?.__resolveType)
        .find((t): t is string => typeof t === "string" && saved.has(t));
      if (!name) return;
      node.experiment = name;
      changed.add(entry);
      report.done.push({
        step: "content",
        subject: files[entry],
        message: `set experiment "${name}" (the random matcher's saved name), so A/B results carry over`,
      });
    });
    const rules = new Set<string>();
    forEachBlock(block, (node) => {
      if (saved.has(node.__resolveType)) {
        rules.add(node.__resolveType);
        becomeExperiment(node, node.__resolveType);
      } else if (RANDOM_MATCHERS.has(node.__resolveType)) {
        const name = inlineName.get(trafficPercent(node.traffic))!;
        rules.add(name);
        becomeExperiment(node, name);
      }
    });
    if (rules.size > 0) {
      changed.add(entry);
      report.done.push({
        step: "content",
        subject: files[entry],
        message: `random rules → the experiment matcher (${[...rules]
          .sort()
          .map((n) => `"${n}"`)
          .join(", ")})`,
      });
    }
  }
  for (const entry of changed) {
    fs.writeFileSync(path.join(blocksDir, files[entry]), serializeBlock(blocks[entry]));
  }
  for (const name of [...saved.keys()].sort()) {
    fs.rmSync(path.join(blocksDir, files[name]));
    report.done.push({
      step: "content",
      subject: files[name],
      message: `deleted: the random matcher is now "${name}" in ${EXPERIMENTS_BLOCK}, at ${experiments[name]}%`,
    });
  }
  if (added.length > 0) {
    const file = files[EXPERIMENTS_BLOCK] ?? blockFileName(EXPERIMENTS_BLOCK);
    fs.writeFileSync(
      path.join(blocksDir, file),
      serializeBlock({ __resolveType: EXPERIMENTS_TYPE, ...experiments }),
    );
    report.done.push({
      step: "content",
      subject: file,
      message: `the A/B tests (${added.map((n) => `"${n}" ${experiments[n]}%`).join(", ")}): each name is the one v7 kept the visitor's group under in deco_segment, so visitors keep their groups; renaming a running test re-rolls everyone`,
    });
  }
  reportAssignment(root, report);
}

/**
 * The experiment each inline random rule becomes, by its percentage: v7's
 * shared name when they all agree, else one experiment per percentage.
 */
function inlineNames(
  inline: JsonObject[],
  experiments: Record<string, number>,
  add: (name: string, percent: number) => void,
  report: Report,
): Map<number, string> {
  const percents = [...new Set(inline.map((n) => trafficPercent(n.traffic)))].sort((a, b) => a - b);
  const names = new Map<number, string>();
  if (percents.length === 1 && experiments[INLINE_EXPERIMENT] === undefined) {
    names.set(percents[0], INLINE_EXPERIMENT);
    add(INLINE_EXPERIMENT, percents[0]);
    return names;
  }
  for (const percent of percents) {
    let name = `Random ${percent}%`;
    for (let i = 2; name in experiments; i++) {
      name = `Random ${percent}% (${i})`;
    }
    names.set(percent, name);
    add(name, percent);
  }
  if (percents.length > 1) {
    report.manual.push({
      step: "content",
      subject: EXPERIMENTS_BLOCK,
      message: `v7 kept every inline random rule under one name (${INLINE_EXPERIMENT}), but these used different traffic shares, so each share is now its own experiment (${percents.map((p) => `"${names.get(p)}"`).join(", ")}) and their visitors are assigned again. Rename them for the business before the release (a running test's name is its key), or save one shared test and point the rules at it`,
    });
  }
  return names;
}

/** What assigns the visitors, by binding: the experiment rules are false until something does. */
function reportAssignment(root: string, report: Report): void {
  const framework = siteFramework(root);
  if (framework === "tanstack") return; // createDecoWorker assigns every page request.
  report.manual.push({
    step: "content",
    subject: EXPERIMENTS_BLOCK,
    message:
      framework === "nextjs"
        ? "assign visitors in proxy.ts: draftProxy from @decocms/nextjs/proxy does it, or decideAssignments, assignmentRequestHeaders and applyAssignments next to the draft calls; the catch-all page's bindDraft and contentClient(cms) then pass them to the experiment matcher"
        : "assign visitors per request: assign(await cms.experiments(), readSegment(request)) from @decocms/blocks/experiments, cms.forRelease({ assignments }), and the returned segmentCookie() on the response when changed (/next/built-in-blocks#experiments); until then every experiment rule is false",
  });
}
