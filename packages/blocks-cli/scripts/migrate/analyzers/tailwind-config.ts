import * as fs from "node:fs";
import * as path from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import type { Node, ObjectLiteralExpression } from "ts-morph";
import type { ReviewItem } from "../types";

/**
 * Static extraction of the parts of a Fresh site's `tailwind.config.ts` that
 * the migrator needs to port into the scaffolded Tailwind v4 `@theme` block:
 * `theme.extend.colors`, `theme.extend.fontFamily`, `theme.extend.screens`,
 * top-level `safelist`, and `plugins` (name only, for the report).
 *
 * This only resolves statically-analyzable literals (string/template
 * literals, array literals, nested object literals). Anything built via a
 * spread, function call, or imported constant is NOT evaluated — the config
 * is deleted after this read, and executing arbitrary site code here would
 * make the migration non-deterministic. Unresolvable nodes become
 * `ReviewItem`s instead, so the gap is a visible finding, not a silent drop.
 */
export interface TailwindConfigExtract {
  /** Flattened color tokens, e.g. "brand-500" -> "#112233" */
  colors: Record<string, string>;
  /** Font family stacks, e.g. "sans" -> "Inter, ui-sans-serif, sans-serif" */
  fontFamily: Record<string, string>;
  /** Custom breakpoints, e.g. "3xl" -> "1920px" */
  screens: Record<string, string>;
  /** Literal safelist entries (string class names) */
  safelist: string[];
  /** Safelist regex patterns, kept as their source text */
  safelistPatterns: string[];
  /** Plugin expressions (source text), for the report only */
  plugins: string[];
  reviewItems: ReviewItem[];
}

const CONFIG_REL_PATH = "tailwind.config.ts";

function emptyExtract(): TailwindConfigExtract {
  return {
    colors: {},
    fontFamily: {},
    screens: {},
    safelist: [],
    safelistPatterns: [],
    plugins: [],
    reviewItems: [],
  };
}

function stripQuotes(name: string): string {
  return name.replace(/^["']|["']$/g, "");
}

/** Find the config's exported object literal, handling both `export default` and `module.exports =`. */
function findConfigObject(sourceFile: import("ts-morph").SourceFile): ObjectLiteralExpression | null {
  const exportAssignment = sourceFile.getExportAssignments()[0];
  if (exportAssignment) {
    let expr: Node = exportAssignment.getExpression();
    while (
      expr.isKind(SyntaxKind.SatisfiesExpression) ||
      expr.isKind(SyntaxKind.AsExpression) ||
      expr.isKind(SyntaxKind.ParenthesizedExpression)
    ) {
      expr = expr.getExpression();
    }
    return expr.isKind(SyntaxKind.ObjectLiteralExpression) ? expr : null;
  }

  for (const stmt of sourceFile.getStatements()) {
    if (!stmt.isKind(SyntaxKind.ExpressionStatement)) continue;
    const expr = stmt.getExpression();
    if (!expr.isKind(SyntaxKind.BinaryExpression)) continue;
    if (expr.getLeft().getText() !== "module.exports") continue;
    const right = expr.getRight();
    if (right.isKind(SyntaxKind.ObjectLiteralExpression)) return right;
  }

  return null;
}

/** Get a direct child object-literal property by name, or undefined. */
function getObjectChild(
  obj: ObjectLiteralExpression,
  name: string,
): ObjectLiteralExpression | undefined {
  const prop = obj.getProperty(name);
  if (!prop || !prop.isKind(SyntaxKind.PropertyAssignment)) return undefined;
  const init = prop.getInitializer();
  return init?.isKind(SyntaxKind.ObjectLiteralExpression) ? init : undefined;
}

function flattenColors(
  obj: ObjectLiteralExpression,
  prefix: string,
  out: Record<string, string>,
  reviewItems: ReviewItem[],
): void {
  for (const prop of obj.getProperties()) {
    if (!prop.isKind(SyntaxKind.PropertyAssignment)) {
      reviewItems.push({
        file: CONFIG_REL_PATH,
        reason: `theme.extend.colors has a non-literal entry (${prop.getKindName()}) — port manually to src/styles/app.css @theme`,
        severity: "warning",
      });
      continue;
    }
    const name = stripQuotes(prop.getName());
    const key = prefix ? `${prefix}-${name}` : name;
    const init = prop.getInitializer();
    if (!init) continue;

    if (init.isKind(SyntaxKind.ObjectLiteralExpression)) {
      flattenColors(init, key, out, reviewItems);
    } else if (
      init.isKind(SyntaxKind.StringLiteral) ||
      init.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
    ) {
      out[key] = init.getLiteralText();
    } else {
      reviewItems.push({
        file: CONFIG_REL_PATH,
        reason: `Color token "${key}" is not a static string literal (${init.getKindName()}) — port manually to src/styles/app.css @theme`,
        severity: "warning",
      });
    }
  }
}

function extractFontFamily(
  obj: ObjectLiteralExpression,
  reviewItems: ReviewItem[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const prop of obj.getProperties()) {
    if (!prop.isKind(SyntaxKind.PropertyAssignment)) continue;
    const name = stripQuotes(prop.getName());
    const init = prop.getInitializer();
    if (!init) continue;

    if (init.isKind(SyntaxKind.ArrayLiteralExpression)) {
      const parts: string[] = [];
      for (const el of init.getElements()) {
        if (
          el.isKind(SyntaxKind.StringLiteral) ||
          el.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
        ) {
          parts.push(el.getLiteralText());
        } else {
          reviewItems.push({
            file: CONFIG_REL_PATH,
            reason: `theme.extend.fontFamily.${name} has a non-literal stack entry (${el.getKindName()}) — port manually`,
            severity: "warning",
          });
        }
      }
      if (parts.length > 0) result[name] = parts.join(", ");
    } else if (
      init.isKind(SyntaxKind.StringLiteral) ||
      init.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
    ) {
      result[name] = init.getLiteralText();
    }
  }
  return result;
}

function extractScreens(obj: ObjectLiteralExpression): Record<string, string> {
  const result: Record<string, string> = {};
  for (const prop of obj.getProperties()) {
    if (!prop.isKind(SyntaxKind.PropertyAssignment)) continue;
    const name = stripQuotes(prop.getName());
    const init = prop.getInitializer();
    if (
      init?.isKind(SyntaxKind.StringLiteral) ||
      init?.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
    ) {
      result[name] = init.getLiteralText();
    }
  }
  return result;
}

function extractSafelist(
  arr: import("ts-morph").ArrayLiteralExpression,
  reviewItems: ReviewItem[],
): { literals: string[]; patterns: string[] } {
  const literals: string[] = [];
  const patterns: string[] = [];
  for (const el of arr.getElements()) {
    if (
      el.isKind(SyntaxKind.StringLiteral) ||
      el.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
    ) {
      literals.push(el.getLiteralText());
    } else if (el.isKind(SyntaxKind.RegularExpressionLiteral)) {
      patterns.push(el.getText());
    } else {
      reviewItems.push({
        file: CONFIG_REL_PATH,
        reason: `safelist entry is not a static string or regex literal (${el.getKindName()}) — Tailwind v4 has no config-based safelist; port manually via @source inline(...) in src/styles/app.css`,
        severity: "warning",
      });
    }
  }
  return { literals, patterns };
}

export function extractTailwindConfig(sourceDir: string): TailwindConfigExtract {
  const configPath = path.join(sourceDir, CONFIG_REL_PATH);
  if (!fs.existsSync(configPath)) return emptyExtract();

  const reviewItems: ReviewItem[] = [];

  let root: ObjectLiteralExpression | null;
  try {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const sourceFile = project.addSourceFileAtPath(configPath);
    root = findConfigObject(sourceFile);
  } catch (e) {
    reviewItems.push({
      file: CONFIG_REL_PATH,
      reason: `Failed to parse tailwind.config.ts (${(e as Error).message}) — custom colors/fonts/safelist were NOT ported. Port manually to src/styles/app.css @theme.`,
      severity: "error",
    });
    return { ...emptyExtract(), reviewItems };
  }

  if (!root) {
    reviewItems.push({
      file: CONFIG_REL_PATH,
      reason:
        "Could not statically locate the config's exported object (expected `export default {...}` or `module.exports = {...}`) — custom colors/fonts/safelist were NOT ported. Port manually to src/styles/app.css @theme.",
      severity: "error",
    });
    return { ...emptyExtract(), reviewItems };
  }

  const themeObj = getObjectChild(root, "theme");
  const extendObj = themeObj ? getObjectChild(themeObj, "extend") : undefined;

  const colorsObj =
    (extendObj && getObjectChild(extendObj, "colors")) ||
    (themeObj && getObjectChild(themeObj, "colors"));
  const colors: Record<string, string> = {};
  if (colorsObj) flattenColors(colorsObj, "", colors, reviewItems);

  const fontFamilyObj =
    (extendObj && getObjectChild(extendObj, "fontFamily")) ||
    (themeObj && getObjectChild(themeObj, "fontFamily"));
  const fontFamily = fontFamilyObj ? extractFontFamily(fontFamilyObj, reviewItems) : {};

  const screensObj =
    (extendObj && getObjectChild(extendObj, "screens")) ||
    (themeObj && getObjectChild(themeObj, "screens"));
  const screens = screensObj ? extractScreens(screensObj) : {};

  let safelist: string[] = [];
  let safelistPatterns: string[] = [];
  const safelistProp = root.getProperty("safelist");
  if (safelistProp?.isKind(SyntaxKind.PropertyAssignment)) {
    const init = safelistProp.getInitializer();
    if (init?.isKind(SyntaxKind.ArrayLiteralExpression)) {
      const r = extractSafelist(init, reviewItems);
      safelist = r.literals;
      safelistPatterns = r.patterns;
    }
  }

  let plugins: string[] = [];
  const pluginsProp = root.getProperty("plugins");
  if (pluginsProp?.isKind(SyntaxKind.PropertyAssignment)) {
    const init = pluginsProp.getInitializer();
    if (init?.isKind(SyntaxKind.ArrayLiteralExpression)) {
      plugins = init.getElements().map((el) => el.getText());
    }
  }

  return { colors, fontFamily, screens, safelist, safelistPatterns, plugins, reviewItems };
}
