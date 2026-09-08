#!/usr/bin/env -S npx tsx
/**
 * Emits `.deco/invoke.native.gen.ts` — the typed handler map a native app feeds
 * to `createNativeInvoke` (`@decocms/native`).
 *
 * ## Why this exists rather than reusing `invoke.gen.ts`
 *
 * `createServerFn` is unreachable off-device **by construction**: its transport
 * is `/_serverFn/<build-generated-id>` and its server half needs the TanStack
 * Start module graph. There is no RPC compiler in Metro. `generate-invoke.ts`
 * therefore produces something a phone can never call.
 *
 * `/deco/invoke/<key>` *is* callable — plain HTTP POST — and the keys are
 * exactly what `generate-loaders.ts` already registers. So this generator does
 * not invent a transport; it types the one that exists.
 *
 * ## Declaration, not activation
 *
 * The emitted file is **types only**. It creates no endpoint, registers no
 * handler, and adds nothing to any bundle — a site that upgrades and never
 * imports it is completely unaffected. That is deliberate: every entry here
 * corresponds to a *public, unauthenticated* HTTP endpoint (see the deny-list
 * below and `generate-invoke.ts:59-76`), and a framework upgrade must never
 * silently widen a site's network surface.
 *
 * Usage:
 *   tsx generate-invoke-native.ts [--loaders-dir src/loaders] [--actions-dir src/actions]
 *                                 [--out .deco/invoke.native.gen.ts]
 */

import fs from "node:fs";
import path from "node:path";
import { Project, type SourceFile, SyntaxKind } from "ts-morph";

/**
 * Never typed for a client, even if the site defines them.
 *
 * Mirrors `generate-invoke.ts`. These take a caller-supplied `entity` and run
 * against admin-credentialed MasterData, so exposing them is broken access
 * control: `searchDocuments({ entity: "CL" })` dumps customer PII. They may
 * still be reachable over `/deco/invoke` — that is a server-side problem — but
 * this generator will not hand an app a typed shortcut to them.
 */
const PRIVILEGED = new Set([
  "createDocument",
  "getDocument",
  "patchDocument",
  "searchDocuments",
  "searchDocumentsFull",
  "uploadAttachment",
]);

export interface HandlerEntry {
  /** The invoke key: `site/actions/newsletter/subscribe`. */
  key: string;
  /** Rendered input type, or `unknown` when it could not be read. */
  input: string;
  /** Rendered output type, or `unknown`. */
  output: string;
  /**
   * Type-only imports this entry needs, each resolved to where the type is
   * ACTUALLY declared — which is frequently not the handler file.
   */
  imports: Array<{ name: string; source: string }>;
}

/** `src/actions/newsletter/subscribe.ts` → `site/actions/newsletter/subscribe` */
function fileToKey(file: string, baseDir: string, prefix: string): string {
  const rel = path
    .relative(baseDir, file)
    .replace(/\\/g, "/")
    .replace(/\.tsx?$/, "");
  return `${prefix}/${rel}`;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    // `_`-prefixed files are shared helpers, not handlers — same convention
    // generate-loaders uses.
    else if (/\.tsx?$/.test(entry.name) && !entry.name.startsWith("_")) out.push(full);
  }
  return out.sort();
}

/** The default-exported function, however the file spells it. */
function findDefaultFunction(sourceFile: SourceFile) {
  const assignment = sourceFile.getExportAssignment((a) => !a.isExportEquals());
  if (assignment) {
    const expression = assignment.getExpression();
    if (expression.getKind() === SyntaxKind.Identifier) {
      const name = expression.getText();
      return (
        sourceFile.getFunction(name) ??
        sourceFile.getVariableDeclaration(name)?.getInitializerIfKind(SyntaxKind.ArrowFunction)
      );
    }
    if (
      expression.getKind() === SyntaxKind.ArrowFunction ||
      expression.getKind() === SyntaxKind.FunctionExpression
    ) {
      return expression.asKind(SyntaxKind.ArrowFunction) ?? undefined;
    }
  }
  return sourceFile.getFunctions().find((f) => f.isDefaultExport());
}

/** Type names a rendered type text refers to, so they can be imported. */
function referencedTypeNames(text: string): string[] {
  // Deliberately shallow: bare identifiers, minus TS built-ins and primitives.
  const BUILTIN = new Set([
    "Promise",
    "Array",
    "Record",
    "Partial",
    "Pick",
    "Omit",
    "Readonly",
    "Map",
    "Set",
    "string",
    "number",
    "boolean",
    "unknown",
    "any",
    "void",
    "null",
    "undefined",
    "Request",
    "Response",
    "Date",
    "object",
    "never",
    "true",
    "false",
  ]);
  return [...new Set(text.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [])].filter((n) => !BUILTIN.has(n));
}

/**
 * Where a referenced type actually lives.
 *
 * Assuming the handler file exports every type it mentions is wrong on real
 * sites: `Person` comes from `@decocms/apps-commerce/types`, and
 * `AddressBookState` is imported from a sibling module. Emitting
 * `import type { Person } from "../src/loaders/user"` produces TS2614 —
 * "has no exported member".
 *
 * Returns null for a type declared locally without `export`, which cannot be
 * named from outside the file at all. The caller degrades that entry rather
 * than emitting something that does not compile.
 */
function resolveTypeSource(
  sourceFile: SourceFile,
  name: string,
  handlerFile: string,
  outDir: string,
): string | null {
  const relativize = (specifier: string): string => {
    // Bare package specifiers resolve the same from anywhere.
    if (!specifier.startsWith(".")) return specifier;
    const absolute = path.resolve(path.dirname(handlerFile), specifier);
    const rel = path.relative(outDir, absolute).replace(/\\/g, "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  };

  // Imported into the handler file → re-emit with its original module.
  for (const declaration of sourceFile.getImportDeclarations()) {
    const named = declaration
      .getNamedImports()
      .find((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === name);
    if (named) return relativize(declaration.getModuleSpecifierValue());
  }

  // Declared and exported here → import from the handler file itself.
  const exported = sourceFile.getExportedDeclarations().get(name);
  if (exported && exported.length > 0) {
    return relativize(`./${path.basename(handlerFile).replace(/\.tsx?$/, "")}`);
  }

  return null;
}

export function collectHandlers(options: {
  loadersDir: string;
  actionsDir: string;
  outDir: string;
}): { entries: HandlerEntry[]; skipped: string[] } {
  const project = new Project({
    compilerOptions: { strict: true },
    skipAddingFilesFromTsConfig: true,
  });

  const files: Array<{ file: string; key: string }> = [
    ...walk(options.loadersDir).map((f) => ({
      file: f,
      key: fileToKey(f, options.loadersDir, "site/loaders"),
    })),
    ...walk(options.actionsDir).map((f) => ({
      file: f,
      key: fileToKey(f, options.actionsDir, "site/actions"),
    })),
  ];

  const entries: HandlerEntry[] = [];
  const skipped: string[] = [];

  for (const { file, key } of files) {
    const name = key.split("/").pop() ?? "";
    if (PRIVILEGED.has(name)) {
      skipped.push(`${key} — privileged action, never typed for a client`);
      continue;
    }

    let sourceFile: SourceFile;
    try {
      sourceFile = project.addSourceFileAtPath(file);
    } catch {
      skipped.push(`${key} — unreadable`);
      continue;
    }

    const fn = findDefaultFunction(sourceFile);
    if (!fn) {
      skipped.push(`${key} — no default-exported function`);
      continue;
    }

    const param = fn.getParameters()[0];
    const input = param?.getTypeNode()?.getText() ?? "unknown";

    const returnNode = fn.getReturnTypeNode()?.getText();
    // `Promise<T>` → `T`; a missing annotation stays `unknown` rather than
    // guessing from inference, which would drag the whole import graph in.
    const output = returnNode?.match(/^Promise<([\s\S]+)>$/)?.[1] ?? returnNode ?? "unknown";

    const referenced = [
      ...new Set([...referencedTypeNames(input), ...referencedTypeNames(output)]),
    ];
    const imports: Array<{ name: string; source: string }> = [];
    const unresolvable: string[] = [];

    for (const name of referenced) {
      const source = resolveTypeSource(sourceFile, name, file, options.outDir);
      if (source) imports.push({ name, source });
      else unresolvable.push(name);
    }

    if (unresolvable.length > 0) {
      // A local, non-exported type cannot be named from outside its file. Emit
      // `unknown` rather than an import that fails to compile.
      skipped.push(`${key} — types not exported: ${unresolvable.join(", ")} (degraded to unknown)`);
    }

    const degrade = (text: string) =>
      unresolvable.reduce(
        (acc, name) => acc.replace(new RegExp(`\\b${name}\\b`, "g"), "unknown"),
        text,
      );

    entries.push({ key, input: degrade(input), output: degrade(output), imports });
  }

  return { entries, skipped };
}

/** `site/actions/wishlist/submit` + `Props` → `Props_wishlist_submit`. */
function aliasFor(key: string, typeName: string): string {
  const suffix = key.split("/").slice(2).join("_").replace(/[^\w]/g, "_");
  return `${typeName}_${suffix}`;
}

export function renderModule(entries: HandlerEntry[]): string {
  // A type name is unique only within the module that declares it. Real sites
  // collide constantly — on a storefront, `Props` and `WishlistState` are each
  // declared by two different modules — and an unaliased import would be a
  // duplicate identifier that fails to compile.
  //
  // Collision is per NAME across distinct SOURCES: the same name from the same
  // module is one import, not a clash.
  const sourcesByName = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const { name, source } of entry.imports) {
      const set = sourcesByName.get(name) ?? new Set<string>();
      set.add(source);
      sourcesByName.set(name, set);
    }
  }
  const collides = (name: string) => (sourcesByName.get(name)?.size ?? 0) > 1;

  const rename = (entry: HandlerEntry, name: string) =>
    collides(name) ? aliasFor(entry.key, name) : name;

  // Group specifiers by module so each source gets one import line.
  const bySource = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const { name, source } of entry.imports) {
      const alias = rename(entry, name);
      const specifier = alias === name ? name : `${name} as ${alias}`;
      const set = bySource.get(source) ?? new Set<string>();
      set.add(specifier);
      bySource.set(source, set);
    }
  }

  const importLines = [...bySource.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([source, specifiers]) =>
        `import type { ${[...specifiers].sort().join(", ")} } from ${JSON.stringify(source)};`,
    );

  const applyRenames = (entry: HandlerEntry, text: string) =>
    entry.imports.reduce((acc, { name }) => {
      const alias = rename(entry, name);
      return alias === name ? acc : acc.replace(new RegExp(`\\b${name}\\b`, "g"), alias);
    }, text);

  const members = entries
    .map(
      (e) =>
        `  ${JSON.stringify(e.key)}: (props: ${applyRenames(e, e.input)}) => Promise<${applyRenames(e, e.output)}>;`,
    )
    .join("\n");

  return `// AUTO-GENERATED by @decocms/blocks-cli generate-invoke-native.ts — do not edit.
//
// The typed handler map for a native app. Feed it to createNativeInvoke:
//
//   const { invoke } = createNativeInvoke<NativeHandlers>({ baseUrl });
//   await invoke.site.actions.newsletter.subscribe({ email });
//
// TYPES ONLY. This file creates no endpoint, registers no handler and adds
// nothing to any bundle — importing it is the opt-in. Each entry corresponds to
// a public, unauthenticated POST /deco/invoke/<key>; that is a property of the
// server, which this file only describes.
${importLines.length > 0 ? `\n${importLines.join("\n")}\n` : "\n"}
export interface NativeHandlers {
${members}
}
`;
}

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(`--${flag}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const loadersDir = path.resolve(arg("loaders-dir", "src/loaders"));
  const actionsDir = path.resolve(arg("actions-dir", "src/actions"));
  const out = path.resolve(arg("out", path.join(".deco", "invoke.native.gen.ts")));

  const { entries, skipped } = collectHandlers({
    loadersDir,
    actionsDir,
    outDir: path.dirname(out),
  });

  // Never silently drop coverage: a skipped handler is one the app cannot call
  // with types, and someone should know which and why.
  for (const reason of skipped) console.warn(`  skipped ${reason}`);

  const contents = renderModule(entries);
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  const existing = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
  if (existing !== contents) await fs.promises.writeFile(out, contents);

  const typed = entries.filter((e) => e.input !== "unknown").length;
  console.log(
    `Generated ${entries.length} invoke handlers (${typed} fully typed) → ${path.relative(process.cwd(), out)}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
