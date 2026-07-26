/**
 * Codemod: upgrade a site off the frozen pre-split `@decocms/start@6.30.0` /
 * `@decocms/apps@5.4.0` packages onto the current 7.x split
 * (`@decocms/tanstack` + `@decocms/blocks` + `@decocms/blocks-admin` +
 * `@decocms/apps-*`). See #367 — this is a DIFFERENT migration than
 * Fresh→TanStack (`deco-migrate`): the site is already on TanStack, it's
 * only the package dependency that needs to move.
 *
 * Mapping derived by hand against a real production site
 * (montecarlo-tanstack) — see the issue for the full worked table. Symbol
 * renames and relocations mean a pure specifier-string rewrite is not
 * enough for every case; those are called out below.
 */

export interface UpgradeResult {
  content: string;
  changed: boolean;
  notes: string[];
}

/** Straightforward 1:1 specifier rewrites — no symbol splitting needed. */
const SIMPLE_SPECIFIER_MAP: Array<{ re: RegExp; to: string }> = [
  { re: /@decocms\/start\/vite\b/g, to: "@decocms/tanstack/vite" },
  { re: /@decocms\/start\/sdk\/cookiePassthrough\b/g, to: "@decocms/tanstack/sdk/cookiePassthrough" },
  { re: /@decocms\/start\/sdk\/workerEntry\b/g, to: "@decocms/tanstack" },
  { re: /@decocms\/start\/sdk\/router\b/g, to: "@decocms/tanstack" },
  { re: /@decocms\/start\/cms\b/g, to: "@decocms/blocks/cms" },
  { re: /@decocms\/start\/setup\b/g, to: "@decocms/blocks/setup" },
  { re: /@decocms\/start\/types\/widgets\b/g, to: "@decocms/blocks/types/widgets" },
  { re: /@decocms\/start\/admin\b/g, to: "@decocms/blocks-admin" },
  { re: /@decocms\/apps\/commerce\/components\/Image\b/g, to: "@decocms/blocks/hooks" },
  { re: /@decocms\/apps\/commerce\//g, to: "@decocms/apps-commerce/" },
  { re: /@decocms\/apps\/vtex\//g, to: "@decocms/apps-vtex/" },
];

/**
 * `@decocms/start/sdk/*` (useScript, useDevice, clx, signal, ...) → the
 * matching `@decocms/blocks/sdk/*` subpath. Runs AFTER the more specific
 * sdk/workerEntry, sdk/router, sdk/cookiePassthrough rewrites above so
 * those aren't double-handled by this catch-all.
 */
const GENERIC_SDK_RE = /@decocms\/start\/sdk\/([\w-]+)/g;

/** Named-import line: `import { A, B as C } from "spec";` (captures the clause + spec). */
const NAMED_IMPORT_RE = /import\s+\{([^}]*)\}\s+from\s+["']([^"']+)["'];?/g;

/** Symbols from `@decocms/start/routes` that move to `@decocms/tanstack/sdk/deferredSectionLoader`. */
const DEFERRED_LOADER_SYMBOL = "deferredSectionLoader";

/** Symbols renamed on the way from `@decocms/start/{routes,hooks}` to `@decocms/tanstack`. */
const ROUTE_FACTORY_RENAMES: Record<string, string> = {
  decoMetaRoute: "decoMetaRouteConfig",
  decoRenderRoute: "decoRenderRouteConfig",
  decoInvokeRoute: "decoInvokeRouteConfig",
};
const HOOKS_RENAMES: Record<string, string> = {
  RenderSection: "SectionRenderer",
};

function splitNamedClause(clause: string): string[] {
  return clause
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Handles the `@decocms/start/routes` and `@decocms/start/hooks` imports, which
 * fan out to `@decocms/tanstack` (root) plus, for routes, a dedicated subpath
 * for `deferredSectionLoader`. Symbol renames are applied to both the import
 * clause and every usage in the file. */
function rewriteRoutesAndHooksImports(
  content: string,
  notes: string[],
): { content: string; changed: boolean } {
  let changed = false;
  // Collected here during the import-line pass, applied to the WHOLE file
  // afterward — must not mutate `content`/the replace target mid-scan.
  const pendingRenames: Array<{ from: string; to: string }> = [];

  let result = content.replace(NAMED_IMPORT_RE, (line, clauseRaw: string, spec: string) => {
    if (spec !== "@decocms/start/routes" && spec !== "@decocms/start/hooks") return line;

    const isRoutes = spec === "@decocms/start/routes";
    const renames = isRoutes ? ROUTE_FACTORY_RENAMES : HOOKS_RENAMES;
    const names = splitNamedClause(clauseRaw);

    const deferred: string[] = [];
    const rootImports: string[] = [];

    for (const name of names) {
      if (isRoutes && name === DEFERRED_LOADER_SYMBOL) {
        deferred.push(name);
        continue;
      }
      const rename = renames[name];
      if (rename) {
        pendingRenames.push({ from: name, to: rename });
        rootImports.push(rename);
        if (isRoutes) {
          notes.push(
            `MANUAL: \`${name}\` is now the factory \`${rename}()\` in @decocms/tanstack — ` +
              `add the call at every usage site (e.g. \`...${rename}()\` instead of \`...${rename}\`).`,
          );
        }
        continue;
      }
      rootImports.push(name);
    }

    changed = true;
    const lines: string[] = [];
    if (rootImports.length > 0) {
      lines.push(`import { ${rootImports.join(", ")} } from "@decocms/tanstack";`);
    }
    if (deferred.length > 0) {
      lines.push(`import { ${deferred.join(", ")} } from "@decocms/tanstack/sdk/deferredSectionLoader";`);
    }
    return lines.join("\n");
  });

  for (const { from, to } of pendingRenames) {
    result = result.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }

  return { content: result, changed };
}

/**
 * Upgrade a single file's source from `@decocms/start` / `@decocms/apps`
 * (pre-7.x-split) specifiers to the current split packages. Pure and
 * side-effect-free — the CLI wrapper handles file I/O and package.json.
 */
export function upgradeFileToV7(content: string): UpgradeResult {
  const notes: string[] = [];
  let result = content;
  let changed = false;

  if (result.includes("@decocms/start/routes") || result.includes("@decocms/start/hooks")) {
    const r = rewriteRoutesAndHooksImports(result, notes);
    result = r.content;
    changed = changed || r.changed;
  }

  for (const { re, to } of SIMPLE_SPECIFIER_MAP) {
    const before = result;
    result = result.replace(re, to);
    if (result !== before) changed = true;
  }

  {
    const before = result;
    result = result.replace(GENERIC_SDK_RE, "@decocms/blocks/sdk/$1");
    if (result !== before) changed = true;
  }

  return { content: result, changed, notes };
}
