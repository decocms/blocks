/**
 * `blocks-migrate`: moves a v7 site to the next major in one pass (spec:
 * renames-and-migrations › Migrating from v7). The steps, in order:
 *
 * 1. content: saved blocks in `.deco/blocks`, v7 generated files removed;
 * 2. secrets: v7 secrets re-encrypted with `.deco/secrets.pub`;
 * 3. block map: `.deco/index.ts` with aliases under the v7 names, after
 *    vendoring the app loaders and actions the content calls;
 * 4. imports: the codemod over `src/`;
 * 5. scripts: `deco schema && deco content` before dev and build.
 *
 * It changes files in place, so run it on a clean working tree and review the
 * diff. What it can't do is returned in the report.
 */
import fs from "node:fs";
import path from "node:path";
import { writeBlockMap } from "./blockMap";
import { moveContent } from "./content";
import { rewriteImports } from "./imports";
import { createReport, type Report } from "./report";
import { reencryptSecrets } from "./secrets";

export interface MigrateOptions {
  /** The app root: the folder with the site's package.json. */
  root: string;
  /** A decofile to split into `.deco/blocks` when the site has none, relative to the root. */
  decofile?: string;
}

/** The scripts /next/cli#run-it-before-dev-and-build asks for. */
const SCRIPTS: Record<string, string> = {
  predev: "deco schema && deco content",
  prebuild: "deco schema && deco content && deco check",
};

function addScripts(root: string, report: Report): void {
  const file = path.join(root, "package.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.scripts ??= {};
  const added: string[] = [];
  for (const [name, command] of Object.entries(SCRIPTS)) {
    const current = manifest.scripts[name];
    if (current === undefined) {
      manifest.scripts[name] = command;
      added.push(name);
    } else if (!current.includes(command)) {
      report.manual.push({
        step: "scripts",
        subject: `package.json ${name}`,
        message: `run ${command} in it (/next/cli#run-it-before-dev-and-build)`,
      });
    }
  }
  if (added.length > 0) {
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    report.done.push({
      step: "scripts",
      subject: "package.json",
      message: `added ${added.join(" and ")}`,
    });
  }
  report.manual.push({
    step: "scripts",
    subject: "package.json",
    message:
      "depend on the next major of @decocms/blocks, drop the v7 codegen from build and the @decocms/blocks-admin and @decocms/blocks-cli dependencies once nothing imports them",
  });
}

export async function migrate(options: MigrateOptions): Promise<Report> {
  const root = path.resolve(options.root);
  if (!fs.existsSync(path.join(root, "package.json"))) {
    throw new Error(`no package.json in ${root}; pass the app root with --root`);
  }
  const report = createReport();
  moveContent(root, report, { decofile: options.decofile });
  await reencryptSecrets(root, report);
  const { vendored } = writeBlockMap(root, report);
  rewriteImports(root, report, vendored);
  addScripts(root, report);
  return report;
}
