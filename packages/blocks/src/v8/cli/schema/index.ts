import path from "node:path";
import { paint } from "../color.ts";
import { writeIfChanged } from "../content.ts";
import { consoleReporter, type Reporter } from "../log.ts";
import { CliError, type DecoPaths, decoPaths, findDecoRoot } from "../root.ts";
import { generateSchema, type SchemaResult } from "./generate.ts";

export interface SchemaOptions {
  root?: string;
  cwd?: string;
  reporter?: Reporter;
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
  const changed = writeIfChanged(paths.schema, `${JSON.stringify(result.meta, null, 2)}\n`);
  return { ...result, written: true, changed };
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

/** `deco schema`, once. Returns the exit code. */
export async function schema(options: SchemaOptions = {}): Promise<number> {
  const reporter = options.reporter ?? consoleReporter;
  const paths = decoPaths(findDecoRoot(options));
  try {
    return reportSchema(await writeSchema(paths), reporter);
  } catch (error) {
    if (error instanceof CliError) {
      reporter.error(error.message);
      return 1;
    }
    throw error;
  }
}
