/**
 * Reads of the whole content, which v8 sites don't do (8.11 on): a site reads
 * the index (`client.routes()`, `client.redirects()`, `client.entries(type?)`:
 * names, types, paths, references and `noIndex`, never a body) and one named
 * block at a time (`client.resolve(name)`). Since 8.11 there is no
 * `client.list(type)`; on a hosted release it fetched every block of the type
 * (one request per block), and a build-time scan of `.deco/blocks` reads
 * content the site no longer bundles.
 *
 * - `list`: a `.list(…)` call on a CMS client (`c`, `cms`, `client`,
 *   `…Client`, `cms.forRelease()`, `cms.forDraft(…)`, `cms.client(…)`,
 *   `currentClient()`): an error. `scripts/checkContentReads.ts` fails on one; the
 *   site's typecheck fails on every other (a wrapper calling it), since
 *   `Client` has no `list`.
 * - `scan`: a directory read or glob of `.deco/blocks` (`readdir`,
 *   `readdirSync`, `glob`, `import.meta.glob`, …; `.deco/blocks.gen` is the
 *   content module, not a scan): reported, since a native app may bundle the
 *   JSON on purpose (reference/native-apps.md).
 *
 * The fix for both: `entries(type)` for what the index knows (a sitemap is
 * the `page` entries' paths without `:param` or `*` and without `noIndex`),
 * or one `resolve(name)` for one block's body (a map keyed by path becomes
 * one saved block per path, found through `entries()`).
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse } from "./compat";
import type { Report } from "./report";

export interface ContentRead {
  /** Relative to the root, with `/`. */
  file: string;
  /** 1-based. */
  line: number;
  kind: "list" | "scan";
  /** The call, as written (first line). */
  code: string;
}

/** Where a site keeps code: the folders scanned, under the root. */
const CODE_DIRS = ["src", "app", "server", "lib", "scripts"];
const SOURCE = /\.(tsx?|mts|cts|jsx?|mjs|cjs)$/;
const SKIPPED = new Set(["node_modules", "dist", "build", ".next", ".output", ".deco-migrate"]);

/** A receiver that is a CMS client by its name or by the call that made it. */
const CLIENT_RECEIVER =
  /(?:^|[.\s(])(?:c|cms|client|[A-Za-z_$][\w$]*Client)$|\b(?:for(?:Release|Draft)|client|currentClient)\([^)]*\)$/;
/** A directory read or glob. */
const SCAN_CALL = /(?:^|\.)(?:readdir|readdirSync|opendir|opendirSync|glob|globSync|sync)$/;
/** `.deco/blocks`, the folder itself or a file in it (not `.deco/blocks.gen`). */
const BLOCKS_DIR = /\.deco\/blocks(?:$|\/|[^.\w])/;

function sourcesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(d.name)) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...sourcesUnder(full));
    else if (d.isFile() && SOURCE.test(d.name) && !d.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** The text of a string literal or a template (its literal parts). */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => s.literal.text).join("");
  }
  return undefined;
}

/** Whether any argument (or a string inside it, as in `path.join(…)`) names `.deco/blocks`. */
function namesBlocksDir(args: readonly ts.Node[]): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const text = literalText(node);
    if (text !== undefined && BLOCKS_DIR.test(text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const arg of args) visit(arg);
  return found;
}

/** The receiver as written, without parentheses, `await`, `!` or spaces: `(await client())` is `client()`. */
function receiverText(node: ts.Expression, source: ts.SourceFile): string {
  let inner: ts.Expression = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAwaitExpression(inner) ||
    ts.isNonNullExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner.getText(source).replace(/\s+/g, "");
}

/** Every `list` call on a CMS client and every scan of `.deco/blocks` in the site's code. */
export function findContentReads(root: string): ContentRead[] {
  const files = CODE_DIRS.flatMap((dir) => sourcesUnder(path.join(root, dir))).sort();
  const found: ContentRead[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes(".list") && !text.includes(".deco/blocks")) continue;
    const source = parse(file, text);
    const at = (node: ts.Node, kind: ContentRead["kind"]) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({
        file: path.relative(root, file).split(path.sep).join("/"),
        line: line + 1,
        kind,
        code: node.getText(source).split("\n")[0]!,
      });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "list" &&
          CLIENT_RECEIVER.test(receiverText(callee.expression, source))
        ) {
          at(node, "list");
        } else if (SCAN_CALL.test(callee.getText(source)) && namesBlocksDir(node.arguments)) {
          at(node, "scan");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const LIST_FIX =
  "client.list() is gone (8.11): client.entries(type) gives names, paths and noIndex from the index (a sitemap: page paths without :param or * and without noIndex), and client.resolve(name) reads one block; a map keyed by path becomes one saved block per path";
const SCAN_FIX =
  "reads every saved block at build time: content comes from the CMS now (hosted releases leave .deco/blocks behind), so read client.entries(type) for paths and noIndex, or resolve one named block; keep it only for a native app that bundles the JSON (reference/native-apps.md)";

/** The migration's report lines: one per `list` call and per scan, as work left. */
export function reportContentReads(root: string, report: Report): ContentRead[] {
  const reads = findContentReads(root);
  for (const read of reads) {
    report.manual.push({
      step: "imports",
      subject: `${read.file}:${read.line}`,
      message: `${read.code}: ${read.kind === "list" ? LIST_FIX : SCAN_FIX}`,
    });
  }
  return reads;
}
