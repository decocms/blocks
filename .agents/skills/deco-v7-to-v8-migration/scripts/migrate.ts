/**
 * `migrate`: moves a v7 site to the next major in one pass (spec:
 * renames-and-migrations › Migrating from v7). The steps, in order:
 *
 * 1. content: saved blocks in `.deco/blocks`, v7 generated files removed,
 *    v7 async-rendering wrappers (Lazy, Deferred) unwrapped to their sections,
 *    legacy type names outside the alias table renamed, and A/B tests keyed
 *    on a random matcher get its name as `experiment`;
 *    then site settings folded into the `CMS` block (`.deco/blocks/CMS.json`);
 * 2. secrets: v7 secrets re-encrypted with `.deco/secrets.pub`;
 * 3. block map: the site's v7 section-loader registration turned into an
 *    export, then `.deco/index.ts` with aliases under the v7 names (v7's
 *    matchers from `@decocms/compat-v7/matchers`, `loadSections` running the
 *    section loaders), after vendoring the app loaders and actions the
 *    content calls, and the view registry `src/views.ts`;
 * 4. invoke: each `/deco/invoke` key the site calls → one server function
 *    (`src/server/invoke.functions.ts` or `invoke.actions.ts`), imported at
 *    each call site; `ctx.invoke`, app state and `useSection` → the stubs in
 *    `src/migration-stubs.ts`;
 * 5. scaffold: `src/cms.ts`, the page loader and the catch-all route for the
 *    binding, replacing v7's page routes;
 * 6. imports: the codemod over `src/` (v7 helpers to `@decocms/compat-v7`,
 *    `ctx.device` from the loader's request, `src/imageUrl.ts` on TanStack);
 * 7. scripts: `deco schema && deco content` before dev and build, and
 *    `deco schema --check` in the site's CI after the install step.
 *
 * Before the block map, v7's app blocks (`deco-vtex`, …) become the client
 * code that configures each platform's client (`src/clients/<app>.ts`).
 *
 * It changes files in place, so run it on a clean working tree and review the
 * diff. What it can't do is returned in the report.
 */
import fs from "node:fs";
import path from "node:path";
import { writeAppClients } from "./apps";
import { unwrapAsyncRendering } from "./asyncRendering";
import { writeBlockMap } from "./blockMap";
import { addSchemaCheck } from "./ciSchemaCheck";
import { listSources, rewriteDeviceReads } from "./compat";
import { moveContent } from "./content";
import { copyExperimentIds } from "./experiments";
import { siteFramework, V8_RANGE } from "./framework";
import { rewriteImports } from "./imports";
import { rewriteInvokes, vtexInvokeMapKeysUsed } from "./invoke";
import { renameLegacyTypes } from "./legacyNames";
import { createReport, type Report } from "./report";
import { writeScaffold } from "./scaffold";
import { reencryptSecrets } from "./secrets";
import { wireSectionLoaders } from "./sectionLoaders";
import { foldSiteSettings } from "./siteSettings";
import { rewriteLoaderContext, rewritePartialImports, writeStubs } from "./stubs";
import { VtexInvokeChoiceNeeded, type VtexInvokeMode } from "./vtexInvoke";

interface MigrateOptions {
  /** The app root: the folder with the site's package.json. */
  root: string;
  /** A decofile to split into `.deco/blocks` when the site has none, relative to the root. */
  decofile?: string;
  /**
   * What the VTEX invoke keys v7's VTEX app answered from its own invoke map
   * become: `"keep"` vendors v7's handler, `"v8"` moves them to
   * `@decocms/apps-vtex`'s client with no v7 code (./vtexInvoke.ts). No
   * default: a site that calls such keys without a choice gets
   * `VtexInvokeChoiceNeeded` before anything is written.
   */
  vtexInvoke?: VtexInvokeMode;
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
  const framework = siteFramework(root);
  const packages = [`@decocms/blocks ${V8_RANGE}`];
  if (framework) {
    packages.push(
      `@decocms/${framework} ${V8_RANGE} (the v8 binding, released with blocks at one version)`,
    );
  }
  const written = siteImports(root);
  if (written.has("@decocms/compat-v7")) {
    packages.push(`@decocms/compat-v7 ${V8_RANGE} (v7's helpers, released with them)`);
  }
  for (const client of ["@decocms/apps-vtex", "@decocms/apps-shopify"]) {
    if (written.has(client)) packages.push(`${client} ${V8_RANGE}`);
  }
  report.manual.push({
    step: "scripts",
    subject: "package.json",
    message: `depend on ${packages.join(", ")}; drop the v7 codegen from build, and @decocms/apps-commerce, @decocms/blocks-admin and @decocms/blocks-cli once nothing imports them`,
  });
}

/** The `@decocms/*` packages the site's code and block map import after the migration. */
function siteImports(root: string): Set<string> {
  const found = new Set<string>();
  const files = [...listSources(path.join(root, "src")), path.join(root, ".deco", "index.ts")];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const [, name] of fs.readFileSync(file, "utf8").matchAll(/["'](@decocms\/[^/"']+)/g)) {
      found.add(name);
    }
  }
  return found;
}

export async function migrate(options: MigrateOptions): Promise<Report> {
  const root = path.resolve(options.root);
  if (!fs.existsSync(path.join(root, "package.json"))) {
    throw new Error(`no package.json in ${root}; pass the app root with --root`);
  }
  if (!options.vtexInvoke) {
    const keys = vtexInvokeMapKeysUsed(root);
    if (keys.length > 0) throw new VtexInvokeChoiceNeeded(keys);
  }
  const report = createReport();
  moveContent(root, report, { decofile: options.decofile });
  unwrapAsyncRendering(root, report);
  renameLegacyTypes(root, report);
  copyExperimentIds(root, report);
  const apps = writeAppClients(root, report);
  foldSiteSettings(root, report);
  await reencryptSecrets(root, report);
  const wiring = wireSectionLoaders(root, report);
  const { vendored } = writeBlockMap(root, report, wiring, apps);
  const stubs = new Set([
    ...rewriteInvokes(root, report, vendored, { vtexInvoke: options.vtexInvoke }),
    ...rewriteLoaderContext(root, report),
    ...rewritePartialImports(root, report),
  ]);
  writeStubs(root, stubs, report);
  rewriteDeviceReads(root, report);
  writeScaffold(root, report);
  rewriteImports(root, report, vendored);
  addScripts(root, report);
  addSchemaCheck(root, report);
  return report;
}
