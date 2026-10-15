import fs from "node:fs";
import path from "node:path";
import { paint } from "../color.ts";
import { writeIfChanged } from "../content.ts";
import { consoleReporter, type Reporter } from "../log.ts";
import { CliError, type DecoPaths, decoPaths, findDecoRoot } from "../root.ts";
import { type DecoMeta, generateSchema, type SchemaResult } from "./generate.ts";

export interface SchemaOptions {
  root?: string;
  cwd?: string;
  reporter?: Reporter;
  /**
   * `--check`: write nothing; fail (exit 1) when `.deco/schema.gen.json`
   * differs from what `deco schema` would write. For CI.
   */
  check?: boolean;
}

export interface WriteSchemaResult extends SchemaResult {
  written: boolean;
  changed: boolean;
}

/**
 * Generate and write `.deco/schema.gen.json`. A schema with errors is not
 * written, so the committed file never holds a half-right form.
 */
export async function writeSchema(paths: DecoPaths): Promise<WriteSchemaResult> {
  const result = await generateSchema(paths);
  if (result.diagnostics.some((d) => d.severity === "error")) {
    return { ...result, written: false, changed: false };
  }
  const changed = writeIfChanged(paths.schema, schemaText(result));
  return { ...result, written: true, changed };
}

/** The file's text, as `deco schema` writes it. */
function schemaText(result: SchemaResult): string {
  return `${JSON.stringify(result.meta, null, 2)}\n`;
}

export interface CheckSchemaResult extends SchemaResult {
  /** `undefined` when the schema has errors, so there is nothing to compare. */
  status?: "up-to-date" | "missing" | "stale";
  /** For a stale file: what differs, one line each. */
  differences: string[];
}

/** `deco schema --check`: compare `.deco/schema.gen.json` with what `deco schema` would write. */
export async function checkSchema(paths: DecoPaths): Promise<CheckSchemaResult> {
  const result = await generateSchema(paths);
  if (result.diagnostics.some((d) => d.severity === "error")) {
    return { ...result, differences: [] };
  }
  let saved: string;
  try {
    saved = fs.readFileSync(paths.schema, "utf8");
  } catch {
    return { ...result, status: "missing", differences: [] };
  }
  if (saved === schemaText(result)) return { ...result, status: "up-to-date", differences: [] };
  return { ...result, status: "stale", differences: describeDifferences(saved, result.meta) };
}

const LISTED = 5;

function names(list: string[]): string {
  const shown = list.slice(0, LISTED).join(", ");
  return list.length > LISTED ? `${shown} and ${list.length - LISTED} more` : shown;
}

/** One line per kind of change, so a CI log says what moved without a diff. */
function describeDifferences(saved: string, meta: DecoMeta): string[] {
  let old: Partial<DecoMeta>;
  try {
    old = JSON.parse(saved);
  } catch {
    return ["the saved file is not valid JSON"];
  }
  if (old === null || typeof old !== "object") return ["the saved file is not a schema"];
  const lines: string[] = [];
  const oldGroups = old.manifest?.blocks ?? {};
  const newGroups = meta.manifest.blocks;
  for (const group of [...new Set([...Object.keys(newGroups), ...Object.keys(oldGroups)])]) {
    const before = Object.keys(oldGroups[group] ?? {});
    const after = Object.keys(newGroups[group] ?? {});
    const added = after.filter((name) => !before.includes(name));
    const removed = before.filter((name) => !after.includes(name));
    if (added.length > 0) lines.push(`${group}: new in code: ${names(added)}`);
    if (removed.length > 0) lines.push(`${group}: no longer in code: ${names(removed)}`);
  }
  const oldDefinitions = old.schema?.definitions ?? {};
  const changed = Object.keys(meta.schema.definitions).filter(
    (key) =>
      Object.hasOwn(oldDefinitions, key) &&
      JSON.stringify(oldDefinitions[key]) !== JSON.stringify(meta.schema.definitions[key]),
  );
  if (changed.length > 0) {
    lines.push(
      `${changed.length} schema definition${changed.length === 1 ? "" : "s"} changed (fields or choices)`,
    );
  }
  if (old.version !== meta.version) {
    lines.push(`written by version ${String(old.version)}; this is ${meta.version}`);
  }
  if (lines.length === 0) lines.push("the content is the same but the formatting differs");
  return lines;
}

export function reportSchemaCheck(result: CheckSchemaResult, reporter: Reporter): number {
  const c = paint(reporter.color);
  for (const d of result.diagnostics) {
    if (d.severity === "error") reporter.error(c.red(d.message));
    else reporter.warn(`${c.yellow("warning")}: ${d.message}`);
  }
  const fix = "Run `deco schema` and commit .deco/schema.gen.json.";
  switch (result.status) {
    case undefined:
      reporter.error(c.red(".deco/schema.gen.json can't be checked: fix the errors above"));
      return 1;
    case "missing":
      reporter.error(c.red(`.deco/schema.gen.json is missing. ${fix}`));
      return 1;
    case "stale":
      reporter.error(
        [
          c.red(
            ".deco/schema.gen.json is out of date: the code's types have changed since it was written.",
          ),
          ...result.differences.map((line) => `  - ${line}`),
          fix,
        ].join("\n"),
      );
      return 1;
    case "up-to-date":
      reporter.info(`.deco/schema.gen.json is up to date with ${path.basename(result.blockMap)}`);
      return 0;
  }
}

export function reportSchema(result: WriteSchemaResult, reporter: Reporter): number {
  const c = paint(reporter.color);
  for (const d of result.diagnostics) {
    if (d.severity === "error") reporter.error(c.red(d.message));
    else reporter.warn(`${c.yellow("warning")}: ${d.message}`);
  }
  if (!result.written) {
    reporter.error(c.red(".deco/schema.gen.json not written: fix the errors above"));
    return 1;
  }
  const groups = result.meta.manifest.blocks;
  const count = (g: string) => Object.keys(groups[g] ?? {}).length;
  reporter.info(
    `${result.changed ? "wrote" : "unchanged"} .deco/schema.gen.json from ${path.basename(result.blockMap)} ` +
      `(${count("sections")} sections, ${count("loaders")} loaders, ${count("matchers")} matchers, ` +
      `${count("pages")} pages, ${count("content")} content types)`,
  );
  return 0;
}

/** `deco schema` (or `deco schema --check`), once. Returns the exit code. */
export async function schema(options: SchemaOptions = {}): Promise<number> {
  const reporter = options.reporter ?? consoleReporter;
  const paths = decoPaths(findDecoRoot(options));
  try {
    if (options.check) return reportSchemaCheck(await checkSchema(paths), reporter);
    return reportSchema(await writeSchema(paths), reporter);
  } catch (error) {
    if (error instanceof CliError) {
      reporter.error(error.message);
      return 1;
    }
    throw error;
  }
}
