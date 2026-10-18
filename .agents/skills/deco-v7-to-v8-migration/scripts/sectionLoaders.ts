/**
 * Section loaders. v7 ran a section's loader only when the site registered
 * it, with `registerSectionLoaders({ "site/sections/…": loader })` from
 * `@decocms/blocks/cms`, and ran them over the page's sections after it
 * resolved. `@decocms/compat-v7/sections` has that runner with v7's rules,
 * taking the loaders as an argument; so this step turns the registration
 * into an export of the same map:
 *
 *   registerSectionLoaders({ … });
 *   → export const sectionLoaders: RunSectionLoadersOptions["loaders"] = { … };
 *
 * and `registerNonCriticalSections([…])` into `export const
 * nonCriticalSections`. The block map then runs them (`loadSections` in
 * `.deco/index.ts`), together with every other section's own `loader`,
 * which v7 never ran: an approved difference (PO 2026-10-15) the block map
 * step reports section by section. The mixins (`withDevice`, `compose`, …) move to
 * `@decocms/compat-v7/sections` in the imports step.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { applyEdits, type Edit, importInsertion, listSources, parse } from "./compat";
import type { Report } from "./report";

const V7_CMS = /^@decocms\/blocks\/cms(\/client)?$/;

/** v7's registration call → the export it becomes. */
const CONVERSIONS: Record<string, { name: string; type: string }> = {
  registerSectionLoaders: { name: "sectionLoaders", type: 'RunSectionLoadersOptions["loaders"]' },
  registerNonCriticalSections: { name: "nonCriticalSections", type: "readonly string[]" },
};

export interface SectionLoaderWiring {
  /** The module that now exports `sectionLoaders`, and the section names it registers (null: not all literal). */
  loaders?: { file: string; keys: Set<string> | null };
  /** The module that now exports `nonCriticalSections`. */
  nonCritical?: { file: string };
}

interface Call {
  file: string;
  /** The v7 function's name in `CONVERSIONS`. */
  v7: string;
  statement: ts.ExpressionStatement;
  call: ts.CallExpression;
  source: ts.SourceFile;
  /** The import specifiers that bring it in. */
  imports: ts.ImportSpecifier[];
}

/** The local names each v7 registration function is imported under, from `@decocms/blocks/cms`. */
function v7Imports(source: ts.SourceFile): Map<string, { v7: string; el: ts.ImportSpecifier }> {
  const out = new Map<string, { v7: string; el: ts.ImportSpecifier }>();
  for (const s of source.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    if (!V7_CMS.test(s.moduleSpecifier.text)) continue;
    const b = s.importClause?.namedBindings;
    if (!b || !ts.isNamedImports(b)) continue;
    for (const el of b.elements) {
      const v7 = (el.propertyName ?? el.name).text;
      if (Object.hasOwn(CONVERSIONS, v7)) out.set(el.name.text, { v7, el });
    }
  }
  return out;
}

function findCalls(file: string, source: ts.SourceFile, nested: number[]): Call[] {
  const locals = v7Imports(source);
  if (locals.size === 0) return [];
  const calls: Call[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      locals.has(node.expression.text)
    ) {
      const { v7, el } = locals.get(node.expression.text)!;
      const statement = node.parent;
      if (
        ts.isExpressionStatement(statement) &&
        statement.parent === source &&
        node.arguments.length === 1
      ) {
        calls.push({ file, v7, statement, call: node, source, imports: [el] });
      } else {
        nested.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** The literal keys of a loader map, or null when it has a spread, a computed key or isn't a literal. */
function literalKeys(arg: ts.Expression): Set<string> | null {
  if (!ts.isObjectLiteralExpression(arg)) return null;
  const keys = new Set<string>();
  for (const p of arg.properties) {
    if (ts.isSpreadAssignment(p) || !p.name) return null;
    if (
      ts.isStringLiteral(p.name) ||
      ts.isIdentifier(p.name) ||
      ts.isNoSubstitutionTemplateLiteral(p.name)
    )
      keys.add(p.name.text);
    else return null;
  }
  return keys;
}

/** The edit that drops `els` from their import declaration, or the whole declaration when nothing is left. */
function dropImports(source: ts.SourceFile, els: ts.ImportSpecifier[]): Edit[] {
  const edits: Edit[] = [];
  const byDecl = new Map<ts.ImportDeclaration, ts.ImportSpecifier[]>();
  for (const el of els) {
    const decl = el.parent.parent.parent as ts.ImportDeclaration;
    byDecl.set(decl, [...(byDecl.get(decl) ?? []), el]);
  }
  for (const [decl, drop] of byDecl) {
    const named = decl.importClause!.namedBindings as ts.NamedImports;
    const keep = named.elements.filter((el) => !drop.includes(el));
    if (keep.length === 0 && !decl.importClause?.name) {
      const text = source.getFullText();
      let end = decl.getEnd();
      if (text[end] === "\n") end++;
      edits.push({ start: decl.getStart(source), end, text: "" });
    } else {
      edits.push({
        start: named.getStart(source),
        end: named.getEnd(),
        text: keep.length === 0 ? "{}" : `{ ${keep.map((el) => el.getText(source)).join(", ")} }`,
      });
    }
  }
  return edits;
}

/**
 * Turns the site's v7 section-loader registrations into exports the block
 * map imports. One call per function site-wide is converted; more, or a call
 * not at a module's top level, is reported.
 */
export function wireSectionLoaders(root: string, report: Report): SectionLoaderWiring {
  const all: Call[] = [];
  const nestedAt: string[] = [];
  for (const file of listSources(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    if (!/\bregister(SectionLoaders|NonCriticalSections)\b/.test(text)) continue;
    const nested: number[] = [];
    all.push(...findCalls(file, parse(file, text), nested));
    const rel = path.relative(root, file).split(path.sep).join("/");
    nestedAt.push(...nested.map((line) => `${rel}:${line}`));
  }
  for (const where of nestedAt) {
    report.manual.push({
      step: "imports",
      subject: where,
      message:
        "a v7 section-loader registration the script couldn't convert (not a top-level call with one argument): export the map instead and run it with runSectionLoaders from @decocms/compat-v7/sections",
    });
  }

  const wiring: SectionLoaderWiring = {};
  const byFile = new Map<string, Call[]>();
  for (const v7 of Object.keys(CONVERSIONS)) {
    const calls = all.filter((c) => c.v7 === v7);
    if (calls.length === 0) continue;
    if (calls.length > 1) {
      report.manual.push({
        step: "imports",
        subject: v7,
        message: `called ${calls.length} times (${calls.map((c) => path.relative(root, c.file)).join(", ")}): merge them into one exported ${CONVERSIONS[v7].name} for the block map's loadSections`,
      });
      continue;
    }
    const [call] = calls;
    byFile.set(call.file, [...(byFile.get(call.file) ?? []), call]);
    if (v7 === "registerSectionLoaders") {
      wiring.loaders = { file: call.file, keys: literalKeys(call.call.arguments[0]) };
    } else {
      wiring.nonCritical = { file: call.file };
    }
  }

  for (const [file, calls] of byFile) {
    const { source } = calls[0];
    const edits: Edit[] = calls.map((c) => {
      const { name, type } = CONVERSIONS[c.v7];
      return {
        start: c.statement.getStart(source),
        end: c.statement.getEnd(),
        text: `export const ${name}: ${type} = ${c.call.arguments[0].getText(source)};`,
      };
    });
    edits.push(
      ...dropImports(
        source,
        calls.flatMap((c) => c.imports),
      ),
    );
    if (calls.some((c) => c.v7 === "registerSectionLoaders")) {
      const at = importInsertion(source);
      const line = 'import type { RunSectionLoadersOptions } from "@decocms/compat-v7/sections";';
      edits.push({ start: at, end: at, text: at === 0 ? `${line}\n` : `\n${line}` });
    }
    fs.writeFileSync(file, applyEdits(source.getFullText(), edits));
    const rel = path.relative(root, file).split(path.sep).join("/");
    report.done.push({
      step: "imports",
      subject: rel,
      message: `${calls.map((c) => `${c.v7}(…) is now export const ${CONVERSIONS[c.v7].name}`).join("; ")}, run by loadSections in .deco/index.ts`,
    });
  }
  return wiring;
}
