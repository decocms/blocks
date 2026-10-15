/**
 * `/deco/invoke` → server functions (spec: renames-and-migrations › Loaders,
 * actions and invoke). v7's browser code called loaders and actions through
 * an invoke proxy (`invoke.site.actions.x(props)`, `invoke["vtex/loaders/y"](props)`,
 * `invoke("key", props)`), which POSTed to `/deco/invoke/<key>`, and the
 * endpoint called the handler as `handler(props, request)`. The next major has
 * no endpoint, so each key the site calls becomes one server function that
 * calls the same handler the same way, and each call site imports it:
 *
 * - TanStack Start: `src/server/invoke.functions.ts`, `createServerFn` per
 *   key; a loader is a GET marked private (`markPrivate`, so the worker never
 *   shares it), an action a POST; `invoke.a.b(props)` → `$aB({ data: props })`;
 * - Next.js: `src/server/invoke.actions.ts` (`"use server"`), one async
 *   function per key; `invoke.a.b(props)` → `$aB(props)`.
 *
 * A key resolves to its handler module as v7's did: `site/<path>` →
 * `src/<path>`, an app's key → the app's loader or action, vendored into
 * `src/vendor` like the block map's. A key v7's VTEX app answered from its
 * own invoke map (a named export, `vtex/actions/checkout/addItemsToCart`)
 * follows the migration's `vtexInvoke` choice (./vtexInvoke.ts). A key with
 * no handler file becomes `unportedInvoke(key, props)` (src/migration-stubs.ts),
 * which rejects; a key the script can't read (a computed property) is
 * reported and left.
 *
 * Only v7's dispatcher is rewritten: `invoke` from `@decocms/blocks/sdk/invoke`
 * (or `@decocms/tanstack`), or from a site module that fetches `/deco/invoke`
 * (v7 templates' `src/runtime.ts`, and its `Runtime.invoke`). A site-local
 * invoke tree of server functions is site code and is left alone.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { applyEdits, type Edit, importInsertion, listSources, parse } from "./compat";
import { type Framework, siteFramework } from "./framework";
import type { Report } from "./report";
import { chainKey, normalizeKey, propertyChain, type Stub, stubImport } from "./stubs";
import { firstFile, locateAppModule, relativeSpecifier, vendorModule } from "./vendor";
import {
  V8_VTEX_OPERATIONS,
  VtexInvokeChoiceNeeded,
  type VtexInvokeMode,
  v8Operation,
  vtexInvokeMapKey,
  writeV8Module,
} from "./vtexInvoke";

const FUNCTIONS_FILE: Record<Framework, string> = {
  tanstack: path.join("src", "server", "invoke.functions.ts"),
  nextjs: path.join("src", "server", "invoke.actions.ts"),
};

/** v7 packages whose `invoke` is the `/deco/invoke` proxy. */
const V7_INVOKE =
  /^@decocms\/(blocks\/sdk\/invoke|blocks\/sdk|tanstack|tanstack\/sdk\/createInvoke)$/;

const HAS_DEFAULT = /\bexport\s+default\b|\bexport\s*\{[^}]*\bdefault\b/;

interface Root {
  /** `invoke` (a proxy) or `Runtime` (an object whose `.invoke` is one). */
  kind: "invoke" | "runtime";
  /** The import declaration and specifier that bind it. */
  decl: ts.ImportDeclaration;
  element: ts.ImportSpecifier;
  /** The module it came from, for the report. */
  from: string;
  /** A site module (src/runtime.ts) that implements the proxy. */
  file?: string;
}

/** The site file a relative or `~/` import names. */
function siteModule(root: string, from: string, specifier: string): string | undefined {
  const base = specifier.startsWith("~/")
    ? path.join(root, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(from), specifier)
      : undefined;
  if (!base) return undefined;
  const clean = base.replace(/\.(js|tsx?)$/, "");
  return firstFile([
    `${clean}.ts`,
    `${clean}.tsx`,
    path.join(clean, "index.ts"),
    path.join(clean, "index.tsx"),
  ]);
}

/** A site module that is v7's invoke proxy: it fetches `/deco/invoke` and defines no server functions. */
function isProxyModule(file: string): boolean {
  const text = fs.readFileSync(file, "utf8");
  return (
    text.includes("/deco/invoke") &&
    !text.includes("createServerFn") &&
    !/["']use server["']/.test(text)
  );
}

function invokeRoots(root: string, file: string, source: ts.SourceFile): Map<string, Root> {
  const roots = new Map<string, Root>();
  for (const s of source.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    if (s.importClause?.isTypeOnly) continue;
    const specifier = s.moduleSpecifier.text;
    const bindings = s.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    let proxyFile: string | undefined;
    if (!V7_INVOKE.test(specifier)) {
      proxyFile = siteModule(root, file, specifier);
      if (!proxyFile || !isProxyModule(proxyFile)) continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      const kind =
        imported === "invoke" ? "invoke" : imported === "Runtime" ? "runtime" : undefined;
      if (kind)
        roots.set(element.name.text, { kind, decl: s, element, from: specifier, file: proxyFile });
    }
  }
  return roots;
}

/** One invoke call found in a file. */
interface Call {
  node: ts.CallExpression;
  key?: string;
  /** The props argument's text, if any. */
  props?: string;
  line: number;
}

/** `site/loaders/gateway/wishlist/add-item` → `$siteLoadersGatewayWishlistAddItem`. */
function functionName(key: string): string {
  const words = key.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words
    .map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1)))
    .join("");
  return `$${name || "invoke"}`;
}

interface Handler {
  key: string;
  file: string;
  /** The module's export that handles it, when not the default (v7's VTEX invoke map). */
  exportName?: string;
  name: string;
  /** "GET" for a loader, "POST" for anything else (v7's invoke was always a POST). */
  method: "GET" | "POST";
}

/** A site file's invoke calls: the keys it names, and the lines of the ones it builds at run time. */
interface FoundInvokes {
  file: string;
  text: string;
  source: ts.SourceFile;
  roots: Map<string, Root>;
  calls: Call[];
  dynamic: number[];
}

/** Every v7 invoke call under `src/`, read only. */
function findInvokeCalls(root: string): FoundInvokes[] {
  const sources = listSources(path.join(root, "src"));
  const found: FoundInvokes[] = [];

  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    if (!/\binvoke\b|\bRuntime\b/.test(text)) continue;
    const source = parse(file, text);
    const roots = invokeRoots(root, file, source);
    if (roots.size === 0) continue;
    const calls: Call[] = [];
    const dynamic: number[] = [];
    const line = (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const chain = propertyChain(node.expression);
        const rootOf = chain && roots.get(chain.root.text);
        if (chain && rootOf) {
          let segments = chain.segments;
          if (rootOf.kind === "runtime") {
            if (segments[0] !== "invoke") {
              ts.forEachChild(node, visit);
              return;
            }
            segments = segments.slice(1);
          }
          if (segments.length === 0) {
            // invoke("key", props)
            const [key, props] = node.arguments;
            if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) {
              calls.push({
                node,
                key: normalizeKey(key.text),
                props: props?.getText(source),
                line: line(node),
              });
            } else {
              dynamic.push(line(node));
            }
          } else {
            const key = chainKey(segments);
            if (key)
              calls.push({
                node,
                key,
                props: node.arguments[0]?.getText(source),
                line: line(node),
              });
            else dynamic.push(line(node));
          }
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (calls.length > 0 || dynamic.length > 0)
      found.push({ file, text, source, roots, calls, dynamic });
  }
  return found;
}

/**
 * The keys of v7's VTEX invoke map (./vtexInvoke.ts) the site calls, sorted,
 * read before the migration writes anything: when there are any, the
 * migration needs `--vtex-invoke`. A site on no v8 binding the script knows
 * keeps its invoke calls as they are, so it needs no choice.
 */
export function vtexInvokeMapKeysUsed(root: string): string[] {
  if (!siteFramework(root)) return [];
  const keys = new Set<string>();
  for (const { calls } of findInvokeCalls(root)) {
    for (const { key } of calls) {
      if (
        key !== undefined &&
        /^vtex\/(loaders|actions)\//.test(key) &&
        !locateAppModule(root, key) &&
        vtexInvokeMapKey(root, key)
      ) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

/**
 * Rewrites v7's invoke calls under `src/` into server functions. Returns the
 * stubs it used. `vendored` is the block map's vendored modules (shared, so
 * an app loader both use is copied once).
 */
export function rewriteInvokes(
  root: string,
  report: Report,
  vendored: Map<string, string>,
  options: { vtexInvoke?: VtexInvokeMode } = {},
): Set<Stub> {
  const vtexInvoke = options.vtexInvoke;
  const framework = siteFramework(root);
  const stubs = new Set<Stub>();
  const found = findInvokeCalls(root);
  if (found.length === 0) return stubs;

  const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");
  if (!framework) {
    const where = found.map((f) => rel(f.file));
    report.manual.push({
      step: "invoke",
      subject: `/deco/invoke calls (${where.slice(0, 3).join(", ")}${where.length > 3 ? `, +${where.length - 3} more` : ""})`,
      message:
        "the site runs on no v8 binding the script knows, so they were left: make each key a server function or route handler of your framework that calls its handler with (props, request), and import it at the call site (reference/server-functions.md)",
    });
    return stubs;
  }

  // Each key's handler: the site's module, or the app's vendored copy.
  const handlers = new Map<string, Handler | null>();
  const names = new Set<string>();
  /** VTEX invoke-map keys: on the v8 client, or why not (`--vtex-invoke v8`); vendored (`keep`). */
  const v8Mapped: string[] = [];
  const v8Unmapped = new Map<string, string>();
  const kept = new Map<string, string>();
  const v8File = path.join(root, "src", "server", "vtex-invoke.server.ts");
  const handlerName = (key: string) => {
    let name = functionName(key);
    for (let n = 2; names.has(name); n++) name = `${functionName(key)}${n}`;
    names.add(name);
    return name;
  };
  const method = (key: string) => (/(^|\/)loaders\//.test(key) ? "GET" : "POST");
  const resolve = (key: string): Handler | null => {
    if (handlers.has(key)) return handlers.get(key)!;
    const mapKey =
      /^vtex\/(loaders|actions)\//.test(key) && !locateAppModule(root, key)
        ? vtexInvokeMapKey(root, key)
        : undefined;
    if (mapKey) {
      // migrate() asks for the choice before writing anything (vtexInvokeMapKeysUsed).
      if (!vtexInvoke) throw new VtexInvokeChoiceNeeded([key]);
      let handler: Handler | null = null;
      if (vtexInvoke === "keep") {
        const before = vendored.size;
        const file = vendorModule(root, mapKey.module, vendored, report);
        if (vendored.size > before) {
          report.done.push({
            step: "vendor",
            subject: mapKey.moduleKey,
            message: `copied to ${rel(file)} for v7's VTEX invoke keys (--vtex-invoke keep); rewrite it over the platform's upstream client (/next/upstream-clients)`,
          });
        }
        kept.set(key, `${rel(file)} ${mapKey.exportName}`);
        handler = {
          key,
          file,
          exportName: mapKey.exportName,
          name: handlerName(key),
          method: method(key),
        };
      } else {
        const v8 = v8Operation(key, framework);
        if ("operation" in v8) {
          v8Mapped.push(key);
          handler = {
            key,
            file: v8File,
            exportName: v8.operation.name,
            name: handlerName(key),
            method: method(key),
          };
        } else {
          v8Unmapped.set(key, v8.reason);
        }
      }
      handlers.set(key, handler);
      return handler;
    }
    let file: string | undefined;
    const [namespace, ...rest] = key.split("/");
    if (namespace === "site" && !rest.includes("..")) {
      const base = path.join(root, "src", ...rest);
      file = firstFile([`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]);
    } else if (/^[a-z0-9-]+\/(loaders|actions)\//.test(key)) {
      const located = locateAppModule(root, key);
      // Only a module whose default export is the handler: v7's apps answered other keys from
      // their own invoke maps, which have no file to call.
      if (located && HAS_DEFAULT.test(fs.readFileSync(located.file, "utf8"))) {
        const before = vendored.size;
        file = vendorModule(root, located, vendored, report);
        if (vendored.size > before) {
          report.done.push({
            step: "vendor",
            subject: key,
            message: `copied to ${rel(file)} for its server function; rewrite it over the platform's upstream client (/next/upstream-clients)`,
          });
        }
      }
    }
    let handler: Handler | null = null;
    if (file && HAS_DEFAULT.test(fs.readFileSync(file, "utf8"))) {
      handler = { key, file, name: handlerName(key), method: method(key) };
    }
    handlers.set(key, handler);
    return handler;
  };

  let functionsFile = path.join(root, FUNCTIONS_FILE[framework]);
  for (let n = 2; fs.existsSync(functionsFile); n++) {
    functionsFile = path.join(
      root,
      FUNCTIONS_FILE[framework].replace(/\.(functions|actions)\.ts$/, `${n}.$1.ts`),
    );
  }
  const missing = new Map<string, Set<string>>();
  const proxies = new Set<string>();
  let rewritten = 0;

  for (const { file, text, source, roots, calls, dynamic } of found) {
    const edits: Edit[] = [];
    const imported = new Set<string>();
    const usedStubs = new Set<Stub>();
    const replaced = new Set<ts.Node>();
    for (const call of calls) {
      const handler = resolve(call.key!);
      let replacement: string;
      if (handler) {
        imported.add(handler.name);
        replacement =
          framework === "tanstack"
            ? `${handler.name}(${call.props ? `{ data: ${call.props} }` : ""})`
            : `${handler.name}(${call.props ?? ""})`;
      } else {
        const stub = v8Unmapped.has(call.key!) ? "unportedVtexInvoke" : "unportedInvoke";
        usedStubs.add(stub);
        stubs.add(stub);
        replacement = `${stub}(${[JSON.stringify(call.key), call.props].filter(Boolean).join(", ")})`;
        const set = missing.get(call.key!) ?? new Set();
        set.add(`${rel(file)}:${call.line}`);
        missing.set(call.key!, set);
      }
      edits.push({ start: call.node.getStart(source), end: call.node.getEnd(), text: replacement });
      replaced.add(call.node);
    }

    // Drop the proxy's import when nothing else in the file uses it.
    for (const [local, rootOf] of roots) {
      let left = 0;
      const count = (node: ts.Node) => {
        if (replaced.has(node)) return;
        if (ts.isIdentifier(node) && node.text === local && node !== rootOf.element.name) {
          const parent = node.parent;
          const isName =
            (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node);
          if (!isName) left++;
        }
        ts.forEachChild(node, count);
      };
      count(source);
      if (left > 0) continue;
      if (rootOf.file) proxies.add(rootOf.file);
      const bindings = rootOf.decl.importClause!.namedBindings as ts.NamedImports;
      const others = bindings.elements.filter((el) => el !== rootOf.element);
      if (others.length === 0 && !rootOf.decl.importClause!.name) {
        let end = rootOf.decl.getEnd();
        if (text[end] === "\n") end++;
        edits.push({ start: rootOf.decl.getStart(source), end, text: "" });
      } else {
        edits.push({
          start: bindings.getStart(source),
          end: bindings.getEnd(),
          text: others.length > 0 ? `{ ${others.map((el) => el.getText(source)).join(", ")} }` : "",
        });
      }
    }

    if (imported.size > 0) {
      const at = importInsertion(source);
      const line = `import { ${[...imported].sort().join(", ")} } from "${relativeSpecifier(file, functionsFile)}";`;
      edits.push({ start: at, end: at, text: at === 0 ? `${line}\n` : `\n${line}` });
    }
    if (usedStubs.size > 0) edits.push(stubImport(file, root, [...usedStubs].sort(), source));
    if (edits.length > 0) {
      fs.writeFileSync(file, applyEdits(text, edits));
      rewritten++;
    }
    if (dynamic.length > 0) {
      report.manual.push({
        step: "invoke",
        subject: `${rel(file)}:${dynamic.join(", ")}`,
        message:
          "an invoke call whose key the script can't read (a computed property or key): give it a server function by hand that calls its handler with (props, request), and import it here (reference/server-functions.md)",
      });
    }
  }

  if (v8Mapped.length > 0) {
    const { clientFile } = writeV8Module(root, framework, v8Mapped);
    report.done.push({
      step: "invoke",
      subject: rel(v8File),
      message: `--vtex-invoke v8: v7's VTEX invoke-map keys on the v8 VTEX client, no v7 code: ${v8Mapped.map((k) => `${k} → vtex.${V8_VTEX_OPERATIONS[k].call.replace(/^vtex\./, "").replace(/\(.*$/s, "")}()`).join(", ")}`,
    });
    report.manual.push({
      step: "invoke",
      subject: `${rel(v8File)} (differences from v7)`,
      message: `list them in the PR: ${v8Mapped.map((k) => `${k}: ${V8_VTEX_OPERATIONS[k].differs}`).join("; ")}`,
    });
    if (!clientFile) {
      report.manual.push({
        step: "invoke",
        subject: "src/clients/vtex.ts",
        message:
          "the site saved no deco-vtex app block, so the script wrote no VTEX client: create src/clients/vtex.ts exporting vtexClient(), a createVtexClient from @decocms/apps-vtex with the store's account (/next/upstream-clients)",
      });
    }
  }
  if (kept.size > 0) {
    report.done.push({
      step: "invoke",
      subject: "VTEX invoke keys (--vtex-invoke keep)",
      message: `v7's VTEX app answered them from its own invoke map; each server function calls v7's handler, vendored: ${[...kept].map(([k, where]) => `${k} → ${where}`).join(", ")}. Run the migration with --vtex-invoke v8 instead to move them to @decocms/apps-vtex's client`,
    });
  }
  const used = [...handlers.values()].filter((h): h is Handler => h !== null);
  if (used.length > 0) {
    writeFunctions(functionsFile, framework, used);
    report.done.push({
      step: "invoke",
      subject: rel(functionsFile),
      message: `${used.length} server functions, one per key the site invoked (${used.map((h) => h.key).join(", ")}), each calling its handler with (props, request) as /deco/invoke did${framework === "tanstack" ? "; loaders are GETs kept out of the shared cache (markPrivate), actions POSTs" : ""}; ${rewritten} files call them now`,
    });
    report.manual.push({
      step: "invoke",
      subject: rel(functionsFile),
      message:
        "these are public endpoints, as /deco/invoke was: validate each input (a zod schema in inputValidator, or in the action), and set the cookies a handler needs with the framework's own API (v7 forwarded RequestContext.responseHeaders, which v8 doesn't have) (reference/server-functions.md)",
    });
  }
  for (const [key, where] of missing) {
    const list = [...where];
    report.manual.push({
      step: "invoke",
      subject: `${key} (${list.slice(0, 3).join(", ")}${list.length > 3 ? `, +${list.length - 3} more` : ""})`,
      message: v8Unmapped.has(key)
        ? `v7's VTEX app answered it from its own invoke map, and the migration ran with --vtex-invoke v8 (no v7 code), but ${v8Unmapped.get(key)}. It's unportedVtexInvoke from src/migration-stubs.ts now, which rejects with the key: write it over the site's VTEX client (src/clients/vtex.ts, /next/upstream-clients) in src/server/vtex-invoke.server.ts and give it a server function, or run the migration with --vtex-invoke keep to vendor v7's handler`
        : key.startsWith("site/")
          ? "no handler file answers this key, so v7's invoke failed with \"handler not found\" too; it's unportedInvoke from src/migration-stubs.ts now, which rejects. Remove the call, or write the handler and its server function"
          : "no module of the installed app is this key's handler (v7's app answered it from its own invoke map, or the app isn't installed), so there was nothing to vendor; it's unportedInvoke from src/migration-stubs.ts now, which rejects. Call the platform's client (/next/upstream-clients) from a server function instead",
    });
  }

  // v7's proxy module, once nothing imports it.
  for (const proxy of proxies) {
    const importers = listSources(path.join(root, "src")).filter((f) => {
      if (f === proxy) return false;
      const t = fs.readFileSync(f, "utf8");
      return [...t.matchAll(/from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].some(
        (m) => siteModule(root, f, m[1] ?? m[2]) === proxy,
      );
    });
    if (importers.length === 0) {
      fs.rmSync(proxy);
      report.done.push({
        step: "invoke",
        subject: rel(proxy),
        message:
          "v7's invoke proxy (it fetched /deco/invoke, which v8 doesn't serve): deleted, nothing imports it now",
      });
    }
  }
  return stubs;
}

function writeFunctions(file: string, framework: Framework, handlers: Handler[]): void {
  const ident = new Map(handlers.map((h, i) => [h.key, `handler${i}`]));
  const header = [
    "/**",
    " * v7's /deco/invoke calls, one server function per key the site invoked (/next/renames-and-migrations#loaders-actions-and-invoke).",
    " * Generated by the deco-v7-to-v8-migration skill; it's your code now. Each calls its handler as v7's",
    " * invoke endpoint did: with the props (v7 sent {} for none) and the request. These are public",
    " * endpoints, as /deco/invoke was: validate each input before you ship.",
    " */",
  ];
  const imports = handlers.map((h) =>
    h.exportName
      ? `import { ${h.exportName} as ${ident.get(h.key)} } from "${relativeSpecifier(file, h.file)}";`
      : `import ${ident.get(h.key)} from "${relativeSpecifier(file, h.file)}";`,
  );
  const input = [
    "",
    "/** The props a v7 handler takes. */",
    "// biome-ignore lint/suspicious/noExplicitAny: any handler",
    "type Input<F> = F extends (props: infer P, ...rest: any[]) => unknown ? P : undefined;",
  ];
  let lines: string[];
  if (framework === "tanstack") {
    const getOnly = handlers.some((h) => h.method === "GET");
    lines = [
      ...header,
      ...(getOnly ? ['import { markPrivate } from "@decocms/tanstack/server";'] : []),
      'import { createServerFn } from "@tanstack/react-start";',
      'import { getRequest } from "@tanstack/react-start/server";',
      ...imports,
      ...input,
      "",
      "/**",
      " * Calls a v7 handler as /deco/invoke did: `handler(props, request)`. Input and result are `any`, as",
      " * v7's invoke was: type each function (a zod inputValidator, a serializable result) as you port it.",
      " */",
      "// biome-ignore lint/suspicious/noExplicitAny: any handler, any result, as v7's invoke",
      "const call = <F extends (...args: any[]) => any>(handler: F, props: Input<F>): Promise<any> =>",
      "  Promise.resolve(handler(props, getRequest()));",
    ];
    for (const h of handlers) {
      const id = ident.get(h.key)!;
      lines.push(
        "",
        `/** ${h.key}${h.method === "GET" ? " (a loader: per visitor, never shared)" : ""} */`,
        `export const ${h.name} = createServerFn({ method: "${h.method}" })`,
        "  // biome-ignore lint/suspicious/noExplicitAny: v7's invoke took any props",
        `  .inputValidator((data?: any) => (data ?? {}) as Input<typeof ${id}>)`,
        h.method === "GET"
          ? `  .handler(({ data }) => {\n    markPrivate();\n    return call(${id}, data);\n  });`
          : `  .handler(({ data }) => call(${id}, data));`,
      );
    }
  } else {
    lines = [
      '"use server";',
      ...header,
      'import { headers } from "next/headers";',
      ...imports,
      ...input,
      "",
      "/** The request a handler gets: this action's headers (cookies included) on the site's origin. */",
      "async function invokeRequest(): Promise<Request> {",
      "  const incoming = await headers();",
      '  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost";',
      '  const protocol = incoming.get("x-forwarded-proto") ?? "https";',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: generated source with a template literal
      "  return new Request(`${protocol}://${host}/`, { headers: new Headers(incoming) });",
      "}",
      "",
      "/** Calls a v7 handler as /deco/invoke did: `handler(props, request)`. */",
      "// biome-ignore lint/suspicious/noExplicitAny: any handler",
      "async function call<F extends (...args: any[]) => any>(handler: F, props: Input<F> | undefined): Promise<Awaited<ReturnType<F>>> {",
      "  return handler(props ?? {}, await invokeRequest());",
      "}",
    ];
    for (const h of handlers) {
      const id = ident.get(h.key)!;
      lines.push(
        "",
        `/** ${h.key} */`,
        `export async function ${h.name}(props?: Input<typeof ${id}>) {`,
        `  return call(${id}, props);`,
        "}",
      );
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}
