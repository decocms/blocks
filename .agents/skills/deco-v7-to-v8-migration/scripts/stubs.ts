/**
 * `src/migration-stubs.ts`: stand-ins for the v7 runtime the next major
 * doesn't have, written where the codemods meet it so the site compiles and
 * every use stays easy to find (each stub is `@deprecated`, so editors strike
 * it through, and `grep migration-stubs` lists what's left):
 *
 * - `unportedInvoke(key, props)`: an invoke the script couldn't turn into a
 *   server function (`ctx.invoke` in a loader, a key with no handler file).
 *   It rejects, as calling `ctx` does in v8;
 * - `appState(name)`: a read of an app's state off v7's loader `ctx`. Throws.
 *
 * Both are typed `any`, as v7's ctx was, so the code around them compiles;
 * - `useSection()` / `usePartialSection()` / `HTMX_LEGACY_URL`: v7 7.x's own
 *   stand-ins for Fresh's partial sections, with 7.x's output (the placeholder
 *   URL), so a page renders as it did. Nothing serves that URL in v7 or v8, so
 *   the `hx-*` attributes that carry it do nothing in either.
 *
 * `rewriteLoaderContext` rewrites `ctx.invoke…(…)` and app-state reads in v7
 * loaders (`(props, req, ctx)`); `rewritePartialImports` points v7's
 * `useSection` imports at the stubs. Both run before the import codemod.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  applyEdits,
  type Edit,
  importInsertion,
  listSources,
  loaderContextOf,
  parse,
  unwrapIdentifier,
} from "./compat";
import type { Report } from "./report";
import { relativeSpecifier } from "./vendor";

export const STUBS_FILE = path.join("src", "migration-stubs.ts");

export type Stub =
  | "unportedInvoke"
  | "appState"
  | "useSection"
  | "usePartialSection"
  | "HTMX_LEGACY_URL";

const STUB_SOURCES: Record<Stub, string[]> = {
  unportedInvoke: [
    "/**",
    " * @deprecated v7's invoke of a loader or action the migration couldn't turn into a server function:",
    " * `ctx.invoke` in a loader (v8 has no ctx), or a key no handler file answers. Call the handler module",
    " * (or the server function in src/server/invoke.functions.ts / invoke.actions.ts) directly.",
    " */",
    "export function unportedInvoke(key: unknown, _props?: unknown): Promise<any> {",
    "  return Promise.reject(",
    "    new Error(",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated source with a template literal
    "      `invoke(${String(key)}) has no v8 equivalent here: call its handler or its server function (see src/migration-stubs.ts)`,",
    "    ),",
    "  );",
    "}",
  ],
  appState: [
    "/**",
    " * @deprecated An app's state read off v7's loader ctx. v8 has no ctx and no apps: pass the setting in",
    " * (a prop, a constant) or create the platform's client in code (src/clients/).",
    " */",
    "export function appState(name: string): any {",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated source with a template literal
    "  throw new Error(`ctx.${name} is gone: v8 has no ctx and no app state (see src/migration-stubs.ts)`);",
    "}",
  ],
  HTMX_LEGACY_URL: [
    "/** @deprecated v7 7.x's placeholder for a partial section's URL; nothing serves it. */",
    'export const HTMX_LEGACY_URL = "/__deco_legacy_htmx_section__";',
  ],
  useSection: [
    "/**",
    " * @deprecated v7 7.x's stand-in for Fresh's partial sections: it returned this placeholder URL, which",
    " * nothing serves, so hx-* attributes that carry it did nothing in v7 and do nothing now. Fetch the",
    " * section's data with a server function and render it with React state instead.",
    " */",
    "export function useSection(_props?: Record<string, unknown>): string {",
    '  return "/__deco_legacy_htmx_section__";',
    "}",
  ],
  usePartialSection: [
    "/** @deprecated See useSection: v7 7.x returned the same placeholder URL. */",
    "export function usePartialSection(_props?: Record<string, unknown>): string {",
    '  return "/__deco_legacy_htmx_section__";',
    "}",
  ],
};

const ORDER: Stub[] = [
  "unportedInvoke",
  "appState",
  "useSection",
  "usePartialSection",
  "HTMX_LEGACY_URL",
];

/** The stubs `src/migration-stubs.ts` exports: the ones it had, plus `stubs`. */
export function writeStubs(root: string, stubs: Iterable<Stub>, report: Report): void {
  const file = path.join(root, STUBS_FILE);
  const wanted = new Set(stubs);
  if (wanted.size === 0) return;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const stub of ORDER) {
    if (new RegExp(`export (function|const) ${stub}\\b`).test(existing)) wanted.add(stub);
  }
  const lines = [
    "/**",
    " * Stand-ins for v7 runtime the next major doesn't have, written by the deco-v7-to-v8-migration skill",
    " * where the site used it. Each is @deprecated: replace every use, then delete this file.",
    " */",
  ];
  for (const stub of ORDER) if (wanted.has(stub)) lines.push("", ...STUB_SOURCES[stub]);
  const text = `${lines.join("\n")}\n`;
  if (text === existing) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  report.done.push({
    step: "imports",
    subject: "src/migration-stubs.ts",
    message: `${ORDER.filter((s) => wanted.has(s)).join(", ")}: @deprecated stand-ins where the site used v7 runtime v8 doesn't have; replace each use (grep migration-stubs), then delete the file`,
  });
}

/** Adds `import { names } from "<stubs>"` to a file's edits (merging into one line). */
export function stubImport(
  file: string,
  root: string,
  names: Iterable<string>,
  source: ts.SourceFile,
): Edit {
  const at = importInsertion(source);
  const line = `import { ${[...new Set(names)].sort().join(", ")} } from "${relativeSpecifier(file, path.join(root, STUBS_FILE))}";`;
  return { start: at, end: at, text: at === 0 ? `${line}\n` : `\n${line}` };
}

/** The key a static invoke chain names (`invoke.vtex.loaders.x` → `vtex/loaders/x`), else undefined. */
export function chainKey(segments: (string | null)[]): string | undefined {
  if (segments.length === 0 || segments.some((s) => s === null)) return undefined;
  return normalizeKey(segments.join("/"));
}

/** v7 accepted keys with or without `.ts`/`.tsx` and a leading slash. */
export function normalizeKey(key: string): string {
  return key.replace(/^\/+/, "").replace(/\.tsx?$/, "");
}

/**
 * The property chain under `expr` down to an identifier: `a.b["c"]?.d` →
 * { root: a, segments: ["b", "c", "d"] }; a non-literal element is `null`.
 */
export function propertyChain(
  expr: ts.Expression,
): { root: ts.Identifier; segments: (string | null)[] } | undefined {
  const segments: (string | null)[] = [];
  let e: ts.Expression = expr;
  for (;;) {
    while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e))
      e = e.expression;
    if (ts.isPropertyAccessExpression(e)) {
      segments.unshift(e.name.text);
      e = e.expression;
    } else if (ts.isElementAccessExpression(e)) {
      const arg = e.argumentExpression;
      segments.unshift(
        ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : null,
      );
      e = e.expression;
    } else if (ts.isIdentifier(e)) {
      return { root: e, segments };
    } else {
      return undefined;
    }
  }
}

/** What a loader's `ctx` gave v7 that isn't app state. `device` is the device step's; `response` is reported. */
const CONTEXT_FIELDS = new Set(["device", "response", "invoke", "getAppState"]);

/**
 * One file's `ctx.invoke…(…)` calls and app-state reads (`ctx.vtex`,
 * `ctx.getAppState("x")`) in v7 loaders, as stub calls. Returns the new text
 * and the stubs used, or undefined when nothing changed.
 */
export function rewriteLoaderContextIn(
  file: string,
  text: string,
  root: string,
): { text: string; stubs: Set<Stub>; lines: number[] } | undefined {
  if (!/\b(ctx|context)\b|Context\b/i.test(text)) return undefined;
  const source = parse(file, text);
  const edits: Edit[] = [];
  const stubs = new Set<Stub>();
  const lines: number[] = [];
  const line = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const args = (call: ts.CallExpression, from = 0) =>
    call.arguments
      .slice(from)
      .map((a) => a.getText(source))
      .join(", ");

  const visit = (node: ts.Node, scope: string[]) => {
    let inner = scope;
    // Only a v7 loader's ctx: `(props, req, ctx)`, not any third `ctx` (react-query's onError context).
    const context = loaderContextOf(node, source);
    if (context?.isRequest) inner = [...scope, context.ctx];
    const isCtx = (e: ts.Expression) => {
      const id = unwrapIdentifier(e);
      return id !== undefined && inner.includes(id.text);
    };

    // ctx.invoke…(…), ctx.invoke(key, props), ctx.getAppState("x")
    if (ts.isCallExpression(node)) {
      const chain = propertyChain(node.expression);
      if (chain && inner.includes(chain.root.text) && chain.segments[0] === "invoke") {
        const rest = chain.segments.slice(1);
        let replacement: string;
        if (rest.length === 0) {
          const [key] = node.arguments;
          const keyText =
            key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))
              ? JSON.stringify(normalizeKey(key.text))
              : (key?.getText(source) ?? "undefined");
          replacement = `unportedInvoke(${[keyText, args(node, 1)].filter(Boolean).join(", ")})`;
        } else {
          const key = chainKey(rest);
          const keyText = key
            ? JSON.stringify(key)
            : JSON.stringify(rest.map((s) => s ?? "?").join("/"));
          replacement = `unportedInvoke(${[keyText, args(node)].filter(Boolean).join(", ")})`;
        }
        edits.push({ start: node.getStart(source), end: node.getEnd(), text: replacement });
        stubs.add("unportedInvoke");
        lines.push(line(node));
        return;
      }
      if (
        chain &&
        inner.includes(chain.root.text) &&
        chain.segments.length === 1 &&
        chain.segments[0] === "getAppState"
      ) {
        edits.push({
          start: node.getStart(source),
          end: node.getEnd(),
          text: `appState(${args(node) || '""'})`,
        });
        stubs.add("appState");
        lines.push(line(node));
        return;
      }
    }

    // ctx.<app>: an app's state.
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isCtx(node.expression)
    ) {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      const assigned =
        ts.isBinaryExpression(node.parent) &&
        node.parent.left === node &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (name !== undefined && !CONTEXT_FIELDS.has(name) && !assigned) {
        edits.push({
          start: node.getStart(source),
          end: node.getEnd(),
          text: `appState(${JSON.stringify(name)})`,
        });
        stubs.add("appState");
        lines.push(line(node));
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(source, []);
  if (edits.length === 0) return undefined;
  edits.push(stubImport(file, root, stubs, source));
  return { text: applyEdits(text, edits), stubs, lines };
}

/** `ctx.invoke` and app-state reads in v7 loaders under `src/`, as stubs. Returns the stubs used. */
export function rewriteLoaderContext(root: string, report: Report): Set<Stub> {
  const used = new Set<Stub>();
  for (const file of listSources(path.join(root, "src"))) {
    if (path.resolve(file) === path.join(root, STUBS_FILE)) continue;
    const text = fs.readFileSync(file, "utf8");
    const out = rewriteLoaderContextIn(file, text, root);
    if (!out) continue;
    fs.writeFileSync(file, out.text);
    for (const s of out.stubs) used.add(s);
    const rel = path.relative(root, file).split(path.sep).join("/");
    report.manual.push({
      step: "imports",
      subject: `${rel}:${[...new Set(out.lines)].join(", ")}`,
      message: `v7's loader ctx (${[...out.stubs].map((s) => (s === "unportedInvoke" ? "ctx.invoke" : "app state")).join(", ")}) became ${[...out.stubs].join(" and ")} from src/migration-stubs.ts, which reject as reading ctx does in v8 (the section keeps its saved props): call the loader's handler module directly with (props, req), and pass settings in or use the platform's client (src/clients/)`,
    });
  }
  return used;
}

const PARTIAL_NAMES = new Set<string>(["useSection", "usePartialSection", "HTMX_LEGACY_URL"]);
const PARTIAL_SPECIFIER = /^@decocms\/blocks\/sdk(\/useScript)?$/;

/**
 * v7's `useSection`, `usePartialSection` and `HTMX_LEGACY_URL` imports →
 * the stubs (7.x's own placeholders, same output). Returns the stubs used;
 * `hx-*` attributes are listed in the report.
 */
export function rewritePartialImports(root: string, report: Report): Set<Stub> {
  const used = new Set<Stub>();
  const htmx: string[] = [];
  for (const file of listSources(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (/\shx-[a-z]+(:[a-z-]+)?=/.test(text)) htmx.push(rel);
    if (!/useSection|usePartialSection|HTMX_LEGACY_URL/.test(text)) continue;
    const source = parse(file, text);
    const edits: Edit[] = [];
    for (const s of source.statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
      if (!PARTIAL_SPECIFIER.test(s.moduleSpecifier.text)) continue;
      const bindings = s.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings) || s.importClause?.name) continue;
      const moved = bindings.elements.filter((el) =>
        PARTIAL_NAMES.has((el.propertyName ?? el.name).text),
      );
      if (moved.length === 0) continue;
      const rest = bindings.elements.filter((el) => !moved.includes(el));
      const quote = s.moduleSpecifier.getText(source)[0];
      const typeOnly = s.importClause?.isTypeOnly ? "type " : "";
      const out = [
        `import ${typeOnly}{ ${moved.map((el) => el.getText(source)).join(", ")} } from ${quote}${relativeSpecifier(file, path.join(root, STUBS_FILE))}${quote};`,
      ];
      if (rest.length > 0)
        out.push(
          `import ${typeOnly}{ ${rest.map((el) => el.getText(source)).join(", ")} } from ${quote}${s.moduleSpecifier.text}${quote};`,
        );
      edits.push({ start: s.getStart(source), end: s.getEnd(), text: out.join("\n") });
      for (const el of moved) used.add((el.propertyName ?? el.name).text as Stub);
    }
    if (edits.length > 0) fs.writeFileSync(file, applyEdits(text, edits));
  }
  if (used.size > 0) {
    report.done.push({
      step: "imports",
      subject: [...used].join(", "),
      message:
        "now come from src/migration-stubs.ts: v7 7.x's own placeholders (the same URL, /__deco_legacy_htmx_section__), so pages render as they did",
    });
  }
  if (htmx.length > 0) {
    report.manual.push({
      step: "imports",
      subject: `hx-* attributes (${htmx.slice(0, 3).join(", ")}${htmx.length > 3 ? `, +${htmx.length - 3} more` : ""})`,
      message:
        "Fresh's partial sections (HTMX): v7 on TanStack Start and Next.js loaded no HTMX and its useSection returned a placeholder URL, so these did nothing in v7 and do nothing now. Rebuild the interaction with a server function and React state, then drop the attributes",
    });
  }
  return used;
}
