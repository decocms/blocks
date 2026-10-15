/**
 * `@decocms/compat-v7`: the one home of v7's pure helpers on v8 (the product
 * owner's call). The codemod points v7 imports of those helpers at it, with
 * v7's output and no v7 runtime:
 *
 * - `@decocms/apps-commerce/<subpath>` → `@decocms/compat-v7/commerce/<subpath>`
 *   (v7's layout under one prefix; the app runtime files have no port);
 * - v7 helper names (`clx`, `detectDevice`, `useScript`, the widget and
 *   section types, the section-loader mixins) → the compat subpath that
 *   exports them (`COMPAT_MOVES`), and `useDevice`/`DeviceProvider` → the
 *   site's binding subpath (`/tanstack` or `/nextjs`);
 * - a v7 section loader's `ctx.device` → `detectDevice(req.headers.get("user-agent") ?? "")`
 *   (`rewriteDeviceReads`): v8 has no `ctx`, and reading it throws.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Framework } from "./framework";
import type { Report } from "./report";

/** Every entry point of `@decocms/compat-v7` (its package.json `exports`; a test keeps them equal). */
export const COMPAT_V7_ENTRIES = [
  "@decocms/compat-v7",
  "@decocms/compat-v7/types",
  "@decocms/compat-v7/types/widgets",
  "@decocms/compat-v7/device",
  "@decocms/compat-v7/script",
  "@decocms/compat-v7/clx",
  "@decocms/compat-v7/matchers",
  "@decocms/compat-v7/sections",
  "@decocms/compat-v7/commerce",
  "@decocms/compat-v7/commerce/types",
  "@decocms/compat-v7/commerce/types/cart",
  "@decocms/compat-v7/commerce/sdk/analytics",
  "@decocms/compat-v7/commerce/sdk/formatPrice",
  "@decocms/compat-v7/commerce/sdk/url",
  "@decocms/compat-v7/commerce/sdk/useOffer",
  "@decocms/compat-v7/commerce/sdk/useVariantPossibilities",
  "@decocms/compat-v7/commerce/utils/canonical",
  "@decocms/compat-v7/commerce/utils/constants",
  "@decocms/compat-v7/commerce/utils/filters",
  "@decocms/compat-v7/commerce/utils/productToAnalyticsItem",
  "@decocms/compat-v7/commerce/utils/stateByZip",
  "@decocms/compat-v7/tanstack",
  "@decocms/compat-v7/tanstack/server",
  "@decocms/compat-v7/nextjs",
  "@decocms/compat-v7/nextjs/server",
  "@decocms/compat-v7/nextjs/proxy",
];

/** The compat entry a v7 `@decocms/apps-commerce/<subpath>` import moves to, if it was ported. */
export function compatCommerceSpecifier(specifier: string): string | undefined {
  // 7.x's package, or the 6.x path a 7.x site sometimes still imports (the same files).
  const sub = /^@decocms\/(?:apps-commerce|apps\/commerce)\/(.+)$/.exec(specifier)?.[1];
  if (!sub) return undefined;
  const target = `@decocms/compat-v7/commerce/${sub.replace(/\.tsx?$/, "")}`;
  return COMPAT_V7_ENTRIES.includes(target) ? target : undefined;
}

const DEVICE = ["Device", "detectDevice", "isMobileUA", "MOBILE_RE", "TABLET_RE"];
/** v7's device context: the binding's compat subpath, which knows where the server's device comes from. */
const DEVICE_CONTEXT = ["DeviceContext", "DeviceProvider", "useDevice"];
const SCRIPT = ["useScript", "useScriptAsDataURI", "inlineScript"];
const TYPES = ["SectionProps", "Resolved", "LoadingFallbackProps", "Flag"];
const WIDGETS = [
  "ButtonWidget",
  "Color",
  "HTMLWidget",
  "ImageWidget",
  "RichText",
  "Secret",
  "TextArea",
  "TextWidget",
  "VideoWidget",
];
const MIXINS = ["compose", "withDevice", "withMobile", "withSearchParam", "withSectionLoader"];

const to = (names: string[], target: string) => names.map((n) => [n, target] as const);
const byBinding = (names: string[]) =>
  names.map(
    (n) =>
      [
        n,
        { tanstack: "@decocms/compat-v7/tanstack", nextjs: "@decocms/compat-v7/nextjs" },
      ] as const,
  );

/** v7 helper names `@decocms/compat-v7` exports with v7's output, by v7 specifier (merged into `MOVES`). */
export const COMPAT_MOVES = {
  "@decocms/blocks": Object.fromEntries(to(TYPES, "@decocms/compat-v7/types")),
  "@decocms/blocks/types": Object.fromEntries(to(TYPES, "@decocms/compat-v7/types")),
  "@decocms/blocks/types/widgets": Object.fromEntries(
    to(WIDGETS, "@decocms/compat-v7/types/widgets"),
  ),
  "@decocms/blocks/sdk": Object.fromEntries([
    ...to(["clx"], "@decocms/compat-v7/clx"),
    ...to(DEVICE, "@decocms/compat-v7/device"),
    ...to(SCRIPT, "@decocms/compat-v7/script"),
    ...byBinding(DEVICE_CONTEXT),
  ]),
  "@decocms/blocks/sdk/clx": Object.fromEntries(to(["clx"], "@decocms/compat-v7/clx")),
  "@decocms/blocks/sdk/detectDevice": Object.fromEntries(to(DEVICE, "@decocms/compat-v7/device")),
  "@decocms/blocks/sdk/useDevice": Object.fromEntries([
    ...to(DEVICE, "@decocms/compat-v7/device"),
    ...byBinding(DEVICE_CONTEXT),
  ]),
  "@decocms/blocks/sdk/useScript": Object.fromEntries(to(SCRIPT, "@decocms/compat-v7/script")),
  "@decocms/blocks/cms": Object.fromEntries(to(MIXINS, "@decocms/compat-v7/sections")),
  "@decocms/blocks/cms/client": Object.fromEntries(to(MIXINS, "@decocms/compat-v7/sections")),
} satisfies Record<string, Record<string, string | Partial<Record<Framework, string>>>>;

/** Hints for the v7 names next to those helpers that have no port, by v7 specifier. */
export const COMPAT_NAME_HINTS: { specifier: RegExp; names: string[]; hint: string }[] = [
  {
    specifier: /^@decocms\/blocks\/sdk(\/useDevice)?$/,
    names: [
      ...DEVICE_CONTEXT,
      "resolveDeviceFromRuntime",
      "checkMobile",
      "checkTablet",
      "checkDesktop",
    ],
    hint: "v7 read the device from its request scope, which v8 has none of: requestDevice() from @decocms/compat-v7/tanstack/server (or /nextjs/server) on the server, useDevice() under DeviceProvider from @decocms/compat-v7/tanstack (or /nextjs) in components, detectDevice(userAgent) from @decocms/compat-v7/device anywhere",
  },
  {
    specifier: /^@decocms\/blocks\/sdk(\/useScript)?$/,
    names: ["useSection", "usePartialSection", "HTMX_LEGACY_URL"],
    hint: "v7's partial sections (HTMX) have no v8 equivalent; v7 7.x's own useSection only returned a placeholder URL (the script points named imports at src/migration-stubs.ts, which keeps it): render the section on the server and fetch it with a server function (reference/server-functions.md)",
  },
  {
    specifier: /^@decocms\/blocks(\/types)?$/,
    names: ["FnContext", "App", "AppContext", "Section"],
    hint: "v7's ctx and apps are gone: a section loader is (props, req) (@decocms/compat-v7/sections), an app is its client created in code (/next/upstream-clients), and a section is a block returning { component, props } (.deco/index.ts)",
  },
  {
    specifier: /^@decocms\/blocks\/cms(\/client)?$/,
    names: [
      "registerSectionLoaders",
      "registerSectionLoader",
      "runSectionLoaders",
      "runSingleSectionLoader",
      "registerNonCriticalSections",
      "registerLayoutSections",
      "unregisterLayoutSections",
    ],
    hint: "v7's section-loader registry: the script turns registerSectionLoaders({ … }) into an exported map the block map's loadSections runs (runSectionLoaders from @decocms/compat-v7/sections); a call it couldn't convert, and runSingleSectionLoader, become runSectionLoader(section, { loaders, request }); a layout section goes in nonCritical (v7 never degraded one), and v8 has no layout cache",
  },
];

const SOURCE = /\.(tsx?|mts|cts)$/;

export function listSources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && SOURCE.test(d.name) && !d.name.endsWith(".d.ts"))
    .map((d) => path.join(d.parentPath, d.name))
    .filter((f) => !f.split(path.sep).includes("node_modules") && !/\.test\.tsx?$/.test(f))
    .sort();
}

export function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** Where a new import line goes: after the last import declaration, else at the top (after a directive). */
export function importInsertion(source: ts.SourceFile): number {
  let at = 0;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) at = statement.getEnd();
    else if (
      at === 0 &&
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression)
    ) {
      at = statement.getEnd(); // "use client" and the like stay first
    } else break;
  }
  return at;
}

/** Whether `name` is bound by an import declaration of the file. */
export function importsName(source: ts.SourceFile, name: string): boolean {
  return source.statements.some((s) => {
    if (!ts.isImportDeclaration(s)) return false;
    const clause = s.importClause;
    if (clause?.name?.text === name) return true;
    const b = clause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) return b.name.text === name;
    return Boolean(b && ts.isNamedImports(b) && b.elements.some((el) => el.name.text === name));
  });
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * When `node` is a v7 loader, `(props, req, ctx)`, its context and request
 * parameter names. The context is named so (`ctx`, `context`) or typed as one
 * (`AppContext`, `FnContext`, …).
 */
export function loaderContextOf(
  node: ts.Node,
  source: ts.SourceFile,
): { ctx: string; req?: string; isRequest: boolean } | undefined {
  if (!isFunctionLike(node) || node.parameters.length < 3) return undefined;
  const [, req, ctx] = node.parameters;
  if (!ts.isIdentifier(ctx.name)) return undefined;
  const isContext =
    /^_?(ctx|context)$/i.test(ctx.name.text) ||
    (ctx.type !== undefined && /Context\b/.test(ctx.type.getText(source)));
  if (!isContext) return undefined;
  return {
    ctx: ctx.name.text,
    req: ts.isIdentifier(req.name) ? req.name.text : undefined,
    // A v7 loader's second parameter is the request: named so, or typed as one.
    isRequest:
      (ts.isIdentifier(req.name) && /^_?(req|request)$/i.test(req.name.text)) ||
      (req.type !== undefined && /^Request$/.test(req.type.getText(source).trim())),
  };
}

/** A read of v7's loader context the codemod leaves: its line and the property read. */
export interface ContextRead {
  line: number;
  read: string;
}

/** `ctx`, `(ctx as X)`, `ctx!`: the identifier under the wrappers, if any. */
export function unwrapIdentifier(expr: ts.Expression): ts.Identifier | undefined {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
    e = e.expression;
  return ts.isIdentifier(e) ? e : undefined;
}

/**
 * Rewrites one file's `ctx.device` reads in v7 section loaders (`(props, req, ctx)`):
 * returns the new text, or undefined when nothing changed. `left` gets the
 * context reads it leaves: `ctx.device` with no request parameter to read,
 * and every other property (`ctx.invoke`, `ctx.response`, an app's state),
 * which v8 has no equivalent for.
 */
export function rewriteDeviceReadsIn(
  file: string,
  text: string,
  left: ContextRead[] = [],
): string | undefined {
  if (!/\b(ctx|context)\b|Context\b/i.test(text)) return undefined;
  const source = parse(file, text);
  const edits: Edit[] = [];
  const local =
    /\bdetectDevice\b/.test(text) && !importsName(source, "detectDevice")
      ? "detectV7Device"
      : "detectDevice";
  const visit = (node: ts.Node, scope: { ctx: string; req?: string }[]) => {
    let inner = scope;
    const context = loaderContextOf(node, source);
    if (context) inner = [...scope, context];
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const id = unwrapIdentifier(node.expression);
      const owner = id && [...inner].reverse().find((s) => s.ctx === id.text);
      if (owner) {
        const read = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : node.argumentExpression.getText(source);
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        if (read === "device" && owner.req) {
          edits.push({
            start: node.getStart(source),
            end: node.getEnd(),
            text: `${local}(${owner.req}.headers.get("user-agent") ?? "")`,
          });
        } else {
          left.push({ line, read });
        }
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(source, []);
  if (edits.length === 0) return undefined;
  if (!importsName(source, local)) {
    const at = importInsertion(source);
    const line =
      local === "detectDevice"
        ? 'import { detectDevice } from "@decocms/compat-v7/device";'
        : 'import { detectDevice as detectV7Device } from "@decocms/compat-v7/device";';
    edits.push({ start: at, end: at, text: at === 0 ? `${line}\n` : `\n${line}` });
  }
  return applyEdits(text, edits);
}

/** `ctx.device` in v7 section loaders under `src/`: v7's device, read from the request the loader gets. */
export function rewriteDeviceReads(root: string, report: Report): void {
  const changed: string[] = [];
  for (const file of listSources(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    const left: ContextRead[] = [];
    const out = rewriteDeviceReadsIn(file, text, left);
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (out !== undefined) {
      fs.writeFileSync(file, out);
      changed.push(rel);
    }
    if (left.length > 0) {
      const reads = [...new Set(left.map((r) => `ctx.${r.read}`))].join(", ");
      const lines = [...new Set(left.map((r) => r.line))].join(", ");
      report.manual.push({
        step: "imports",
        subject: `${rel}:${lines}`,
        message: `reads ${reads} in a v7 loader, and v8 has no ctx: a loader run by loadSections that reads it throws, and its section keeps its saved props. Read the device with detectDevice(req.headers.get("user-agent") ?? "") from @decocms/compat-v7/device (with the request as the second parameter), call the app's client or the site's server function instead of ctx.invoke, and pass settings in instead of reading app state`,
      });
    }
  }
  if (changed.length > 0) {
    report.done.push({
      step: "imports",
      subject: "ctx.device",
      message: `read from the loader's request with detectDevice (@decocms/compat-v7/device), as v7 computed it, in ${changed.join(", ")}`,
    });
  }
}
