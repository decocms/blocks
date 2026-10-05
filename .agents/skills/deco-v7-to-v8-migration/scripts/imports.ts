/**
 * The import codemod: v7 `@decocms/*` imports in the site's `src/`.
 *
 * It rewrites only what has a v8 equivalent with the same meaning:
 *
 * - an import of a vendored module (`@decocms/apps-shopify/loaders/…`)
 *   points at the copy in `src/vendor`;
 * - `createInstrumentedFetch` from `@decocms/blocks/sdk/instrumentedFetch`
 *   comes from `@decocms/blocks/fetch`, and `createInstrumentedFetch("x")`
 *   becomes `createInstrumentedFetch({ provider: "x" })`.
 *
 * Every other v7 import is reported with where its replacement lives; none
 * is shimmed. Imports of the next major's documented entry points are left
 * alone.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Report } from "./report";
import { relativeSpecifier, resolvePackageFile } from "./vendor";

/** The next major's documented API (/next/api-reference): imports of these stay. */
export const V8_API: Record<string, ReadonlySet<string> | "*"> = {
  // The root's next-major exports (packages/blocks/src/index.ts, from ./v8).
  "@decocms/blocks": new Set([
    "Analytics",
    "Block",
    "BlockFunction",
    "Blocks",
    "Client",
    "CMS",
    "CMSError",
    "CMSSettings",
    "createCMS",
    "DraftPointer",
    "EffectiveSettings",
    "formatDraftPointer",
    "Lazy",
    "ListOptions",
    "Loader",
    "Match",
    "matchRoute",
    "Page",
    "parseDraftPointer",
    "Redirect",
    "RequestLike",
    "Result",
    "Route",
    "remoteLoader",
    "resetForTests",
    "Secret",
    "Seo",
    "Snapshot",
    "Telemetry",
    "TelemetryConfig",
    "Variant",
  ]),
  "@decocms/blocks/fetch": "*",
  "@decocms/blocks/analytics": "*",
  "@decocms/blocks/secrets": "*",
  "@decocms/blocks/cli": "*",
};

/** Where each v7 import's replacement lives, first match wins. */
const HINTS: [RegExp, string][] = [
  [/^@decocms\/start(\/|$)/, "a 6.x import: upgrade the site to 7.x first"],
  [
    /^@decocms\/blocks\/sdk\/cachedLoader$/,
    "cachedLoader is gone: an upstream cache is your own fetch, passed to createInstrumentedFetch (/next/caching#upstream-data)",
  ],
  [
    /(^|\/)(invoke|createInvoke)$|\/sdk\/invoke/,
    "/deco/invoke is gone: call upstream clients from server functions or route handlers (/next/renames-and-migrations#loaders-actions-and-invoke)",
  ],
  [
    /^@decocms\/blocks-admin(\/|$)/,
    "next-major sites serve no admin endpoints; the site editor uses the content protocol (/next/studio-compatibility)",
  ],
  [
    /^@decocms\/blocks-cli(\/|$)/,
    "codegen is the deco CLI in @decocms/blocks: deco schema, deco content, deco check (/next/cli)",
  ],
  [
    /^@decocms\/blocks\/(setup|cms)(\/|$)/,
    "setup is createCMS from @decocms/blocks, with the block map in .deco/index.ts (/next/content#create-the-cms)",
  ],
  [
    /^@decocms\/blocks\/sdk\/instrumentedFetch$/,
    "createInstrumentedFetch({ provider, fetch?, retry?, circuitBreaker? }) from @decocms/blocks/fetch (/next/api-reference#createinstrumentedfetch-options)",
  ],
  [
    /^@decocms\/blocks\/(sdk\/(otel|observability|logger)|middleware\/observability)/,
    "telemetry is the telemetry option of createCMS (/next/telemetry)",
  ],
  [
    /^@decocms\/blocks\/types\/widgets$/,
    "type the field as a string with a @format tag (/next/schema#widgets)",
  ],
  [
    /(OneDollarStats|Analytics)$|^@decocms\/blocks\/sdk\/analytics$/,
    "AnalyticsScript and track from @decocms/blocks/analytics, with the analytics section of cms.settings() (/next/analytics)",
  ],
  [
    /^@decocms\/apps-salesforce(\/|$)|^@decocms\/apps\/salesforce(\/|$)/,
    "the Salesforce client is @decocms/apps-sfmc-personalization (/next/upstream-clients#what-a-client-is)",
  ],
  [
    /^@decocms\/apps-commerce(\/|$)|^@decocms\/apps\/commerce(\/|$)/,
    "converters, hooks and shared commerce types live in your platform template (/next/upstream-clients#what-a-client-is)",
  ],
  [
    /^@decocms\/apps-website(\/|$)|^@decocms\/apps\/website(\/|$)/,
    "website features (SEO, sitemaps, redirects) live in your platform template (/next/upstream-clients#what-a-client-is)",
  ],
  [
    /^@decocms\/apps(-[a-z]+)?(\/|$)/,
    "apps are thin upstream clients now; call the platform's client from your own code (/next/upstream-clients)",
  ],
  [
    /^@decocms\/(tanstack|nextjs)(\/|$)/,
    "the v7 framework binding: the next major has none, so drop the dependency and follow your framework's guide (/next/tanstack-start-descriptors, /next/nextjs)",
  ],
];
const DEFAULT_HINT = "no v8 equivalent";
/** Prerelease root exports that became CMS methods. */
const DRAFT_HELPERS = new Set(["draftPointer", "draftCookie", "DRAFT_COOKIE"]);
const DRAFT_HINT =
  "draftPointer and draftCookie are the async cms.draftPointer and cms.draftCookie now (they check the preview hosts), and DRAFT_COOKIE is gone: pass cms.draftPointer the request, or { url, headers } (/next/api-reference#draft-pointers)";

const SOURCE = /\.(tsx?|mts|cts)$/;

function listSources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && SOURCE.test(d.name) && !d.name.endsWith(".d.ts"))
    .map((d) => path.join(d.parentPath, d.name))
    .filter((f) => !f.split(path.sep).includes("node_modules"));
}

interface Found {
  /** The string literal node holding the specifier. */
  literal: ts.StringLiteral;
  /** Named imports (`*` for a namespace or default import). */
  names: string[];
  declaration?: ts.ImportDeclaration;
}

function findImports(source: ts.SourceFile): Found[] {
  const found: Found[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const names: string[] = [];
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.name) names.push("default");
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) names.push((el.propertyName ?? el.name).text);
      } else {
        names.push("*");
      }
      found.push({
        literal: node.moduleSpecifier,
        names,
        declaration: ts.isImportDeclaration(node) ? node : undefined,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ literal: node.arguments[0], names: ["*"] });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      found.push({ literal: node.argument.literal, names: ["*"] });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isDocumented(specifier: string, names: string[]): boolean {
  const api = V8_API[specifier];
  if (!api) return false;
  return api === "*" || names.every((n) => api.has(n));
}

function hintFor(specifier: string, names: Iterable<string>): string {
  if (specifier === "@decocms/blocks" && [...names].some((n) => DRAFT_HELPERS.has(n))) {
    return DRAFT_HINT;
  }
  return HINTS.find(([pattern]) => pattern.test(specifier))?.[1] ?? DEFAULT_HINT;
}

/** `createInstrumentedFetch("x")` calls, or null when one has another argument shape. */
function instrumentedFetchCalls(source: ts.SourceFile, local: string): ts.CallExpression[] | null {
  const calls: ts.CallExpression[] = [];
  let convertible = true;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === local
    ) {
      const [arg] = node.arguments;
      if (node.arguments.length === 1 && arg && ts.isStringLiteralLike(arg)) calls.push(node);
      else convertible = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return convertible ? calls : null;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Rewrite and report the `@decocms/*` imports of every source file in `src/`.
 * `vendored` maps an installed source file to its copy in the site.
 */
export function rewriteImports(root: string, report: Report, vendored: Map<string, string>): void {
  const reported = new Map<string, { names: Set<string>; files: Set<string> }>();
  let rewrittenFiles = 0;

  for (const file of listSources(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("@decocms/")) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const edits: Edit[] = [];
    const rel = path.relative(root, file).split(path.sep).join("/");

    for (const found of findImports(source)) {
      const specifier = found.literal.text;
      if (!specifier.startsWith("@decocms/")) continue;
      const replace = (to: string) =>
        edits.push({
          start: found.literal.getStart(source) + 1,
          end: found.literal.getEnd() - 1,
          text: to,
        });

      // 1. A vendored module: import the copy.
      const target = resolvePackageFile(root, specifier);
      const copy = target ? vendored.get(target) : undefined;
      if (copy) {
        replace(relativeSpecifier(file, copy));
        continue;
      }

      // 2. createInstrumentedFetch moved to @decocms/blocks/fetch, options-only.
      const decl = found.declaration;
      const bindings = decl?.importClause?.namedBindings;
      if (
        specifier === "@decocms/blocks/sdk/instrumentedFetch" &&
        decl &&
        !decl.importClause?.isTypeOnly &&
        !decl.importClause?.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length === 1 &&
        (bindings.elements[0].propertyName ?? bindings.elements[0].name).text ===
          "createInstrumentedFetch"
      ) {
        const calls = instrumentedFetchCalls(source, bindings.elements[0].name.text);
        if (calls) {
          replace("@decocms/blocks/fetch");
          for (const call of calls) {
            const arg = call.arguments[0];
            edits.push({
              start: arg.getStart(source),
              end: arg.getEnd(),
              text: `{ provider: ${arg.getText(source)} }`,
            });
          }
          continue;
        }
      }

      // 3. The next major's documented API: nothing to do.
      if (isDocumented(specifier, found.names)) continue;

      // 4. Everything else: report.
      const entry = reported.get(specifier) ?? { names: new Set(), files: new Set() };
      for (const n of found.names) entry.names.add(n);
      entry.files.add(
        `${rel}:${source.getLineAndCharacterOfPosition(found.literal.getStart(source)).line + 1}`,
      );
      reported.set(specifier, entry);
    }

    if (edits.length > 0) {
      let out = text;
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
      }
      fs.writeFileSync(file, out);
      rewrittenFiles++;
    }
  }

  if (rewrittenFiles > 0) {
    report.done.push({
      step: "imports",
      subject: "src/",
      message: `rewrote imports in ${rewrittenFiles} files`,
    });
  }
  for (const [specifier, { names, files }] of [...reported].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const list = [...files];
    const where = `${list.slice(0, 3).join(", ")}${list.length > 3 ? `, +${list.length - 3} more` : ""}`;
    report.manual.push({
      step: "imports",
      subject: `${specifier} {${[...names].join(", ")}}`,
      message: `${hintFor(specifier, names)}; in ${where}`,
    });
  }
}
