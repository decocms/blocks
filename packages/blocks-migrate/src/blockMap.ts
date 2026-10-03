/**
 * The block map (spec: renames-and-migrations › Rename a block type). Saved
 * content names v7 types by file path, like `site/sections/Product/Shelf.tsx`;
 * the next major resolves a name only through `.deco/index.ts`. This step
 * writes that file: one entry per type, under a short name, plus an alias
 * under every v7 name the content stores, so the content keeps resolving.
 *
 * - The site's own modules (`site/…`) are registered from `src/`, every
 *   section under `src/sections` included, so editors can still add them.
 * - App loaders and actions the content calls are vendored first (see
 *   ./vendor.ts) and registered from the copy.
 * - Built-ins and the legacy names the runtime already maps (`page`,
 *   `multivariate`, …) need no entry.
 * - Everything else has no v8 equivalent; it is reported, not registered.
 *
 * Sections return render descriptors, `{ component, props }`, and `page`
 * takes them (see /next/tanstack-start-descriptors): it works in any
 * framework, and the site's view registry maps each component name to the
 * section it renders.
 */
import fs from "node:fs";
import path from "node:path";
import { BUILT_IN_BLOCKS, LEGACY_ALIASES } from "@decocms/blocks/cli";
import type { Report } from "./report";
import { locateAppModule, vendorModule } from "./vendor";
import { forEachBlock, readContent } from "./walk";

type Kind = "section" | "function";

interface Entry {
  /** The module that holds the block function (default export). */
  file: string;
  kind: Kind;
  /** The v7 names content stores for it. */
  legacy: string[];
  short: string;
  ident: string;
}

/** Where to look for a type without a v8 equivalent. */
const HINTS: [RegExp, string][] = [
  [
    /\/apps\//,
    "a v7 app block; the next major has no apps: create the platform's client in code with these settings (/next/upstream-clients#call-a-client), then delete the saved block",
  ],
  [
    /^website\/sections\/Rendering\/(Lazy|Deferred|SingleDeferred)\.tsx?$/,
    "v7's Lazy section wrapper: register a block under this name that returns its `section` (it renders normally), or unwrap it in the content",
  ],
  [
    /\/sections\/Seo\//,
    "an SEO section: register your platform template's SEO block under this name (/next/renames-and-migrations#rename-a-type-with-an-alias)",
  ],
  [
    /^website\/sections\/Analytics\//,
    "v7's Analytics section: move its tag IDs into your template's tag-manager block (/next/renames-and-migrations#telemetry-and-analytics)",
  ],
  [
    /\/matchers\//,
    "a v7 matcher with no built-in: register a matcher block under this name (/next/matchers-and-variants#matchers)",
  ],
  [
    /^website\/functions\/requestToParam/,
    "reads the request; take route params from matchRoute's `params` instead (/next/api-reference#matchroute-url-items)",
  ],
];
const DEFAULT_HINT =
  "no v8 equivalent and no installed source to vendor: register a block under this name in .deco/index.ts, or migrate the content";

function hintFor(type: string): string {
  return HINTS.find(([pattern]) => pattern.test(type))?.[1] ?? DEFAULT_HINT;
}

function kebab(name: string): string {
  return name
    .replace(/\.(tsx?|jsx?)$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

const RESERVED_WORDS = new Set(
  `arguments await break case catch class const continue debugger default delete do else enum eval
  export extends false finally for function if implements import in instanceof interface let new null
  package private protected public return static super switch this throw true try typeof var void
  while with yield`.split(/\s+/),
);

function camel(name: string): string {
  const ident = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  if (/^[0-9]/.test(ident)) return `_${ident}`;
  return RESERVED_WORDS.has(ident) ? `${ident}Block` : ident;
}

function firstFile(candidates: string[]): string | undefined {
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
}

function moduleFile(base: string): string | undefined {
  return /\.(tsx?)$/.test(base) ? firstFile([base]) : firstFile([`${base}.ts`, `${base}.tsx`]);
}

function listFiles(dir: string, ext: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && ext.test(d.name) && !/\.test\.tsx?$/.test(d.name))
    .map((d) => path.join(d.parentPath, d.name));
}

const HAS_DEFAULT = /\bexport\s+default\b|\bexport\s*\{[^}]*\bdefault\b/;
const HAS_LOADER =
  /\bexport\s+(?:async\s+)?(?:function|const|let)\s+loader\b|\bexport\s*\{[^}]*\bloader\b/;

function posix(p: string): string {
  return p.split(path.sep).join("/");
}

function importPath(root: string, file: string): string {
  const rel = posix(path.relative(path.join(root, ".deco"), file)).replace(/\.tsx?$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

interface BlockMapResult {
  /** Each vendored module: installed source → its copy in the site. */
  vendored: Map<string, string>;
}

/** Write `.deco/index.ts` from the site's content and sources. Keeps an existing block map. */
export function writeBlockMap(root: string, report: Report): BlockMapResult {
  const existing = ["index.ts", "index.tsx"].find((f) =>
    fs.existsSync(path.join(root, ".deco", f)),
  );
  if (existing) {
    report.manual.push({
      step: "block map",
      subject: `.deco/${existing}`,
      message: "already exists, so it was kept; delete it and run again to generate one",
    });
    return { vendored: new Map() };
  }

  const { blocks, files } = readContent(root);
  const used = new Map<string, Set<string>>();
  for (const [entry, block] of Object.entries(blocks)) {
    forEachBlock(block, ({ __resolveType: type }) => {
      if (!used.has(type)) used.set(type, new Set());
      used.get(type)!.add(files[entry]);
    });
  }
  const builtIn = new Set(BUILT_IN_BLOCKS);
  const types = new Set(
    [...used.keys()].filter(
      (t) => !Object.hasOwn(blocks, t) && !builtIn.has(t) && !Object.hasOwn(LEGACY_ALIASES, t),
    ),
  );
  for (const file of listFiles(path.join(root, "src", "sections"), /\.tsx$/)) {
    const type = `site/${posix(path.relative(path.join(root, "src"), file))}`;
    if (!types.has(type) && !types.has(type.replace(/\.tsx$/, ""))) types.add(type);
  }

  const byFile = new Map<string, Entry>();
  const vendored = new Map<string, string>();
  const leave = (type: string, message: string) => {
    const where = [...(used.get(type) ?? [])];
    const usedIn =
      where.length > 0
        ? ` (in ${where.slice(0, 3).join(", ")}${where.length > 3 ? ", …" : ""})`
        : "";
    report.manual.push({ step: "block map", subject: `${type}${usedIn}`, message });
  };

  for (const type of [...types].sort()) {
    const [namespace, group] = type.split("/");
    const kind: Kind = group === "sections" ? "section" : "function";
    let file: string | undefined;
    if (namespace === "site") {
      const rest = type.slice("site/".length);
      if (rest.split("/").includes("..")) {
        leave(
          type,
          "not a path inside src/; register a block under this name, or migrate the content",
        );
        continue;
      }
      if (rest.startsWith("apps/")) {
        leave(type, hintFor(type));
        continue;
      }
      file = moduleFile(path.join(root, "src", rest));
      if (!file) {
        leave(
          type,
          `no src/${rest} in the site; register a block under this name, or migrate the content`,
        );
        continue;
      }
    } else if (group === "loaders" || group === "actions") {
      const located = locateAppModule(root, type);
      if (!located) {
        leave(type, hintFor(type));
        continue;
      }
      const before = vendored.size;
      file = vendorModule(root, located, vendored, report);
      const count = vendored.size - before;
      report.done.push({
        step: "vendor",
        subject: type,
        message: `copied to ${posix(path.relative(root, file))}${count > 1 ? ` with ${count - 1} more files` : ""}; rewrite it over the platform's upstream client (/next/upstream-clients)`,
      });
    } else {
      leave(type, hintFor(type));
      continue;
    }

    const source = fs.readFileSync(file, "utf8");
    if (!HAS_DEFAULT.test(source)) {
      leave(type, `${posix(path.relative(root, file))} has no default export to register`);
      continue;
    }
    const entry = byFile.get(file);
    if (entry) {
      entry.legacy.push(type);
      continue;
    }
    byFile.set(file, { file, kind, legacy: [type], short: "", ident: "" });
    if (kind === "section" && HAS_LOADER.test(source)) {
      leave(
        type,
        "the section has a loader: its saved props are the loader's input (as in v7), but nothing runs the loader; move that code into the block function or a server function",
      );
    }
    if (group === "actions") {
      leave(
        type,
        "an action: block functions should only read; call it from a server function or route handler instead (/next/renames-and-migrations#loaders-actions-and-invoke)",
      );
    }
  }

  // Short names: the file's name, then its path, then a number; never a
  // built-in, a saved block's name or a v7 name.
  const taken = new Set<string>([...builtIn, ...Object.keys(blocks), ...types]);
  const idents = new Set<string>(["section", "PropsOf"]);
  const entries = [...byFile.values()];
  for (const entry of entries) {
    const type = entry.legacy[0];
    const segments = type.split("/");
    const prefix = segments[0] === "site" ? "" : `${segments[0]}-`;
    const candidates = [
      prefix + kebab(segments.at(-1)!),
      prefix + kebab(segments.slice(2).join("-")),
    ];
    let short = candidates.find((c) => c && !taken.has(c));
    for (let n = 2; !short; n++)
      if (!taken.has(`${candidates[1]}-${n}`)) short = `${candidates[1]}-${n}`;
    taken.add(short);
    entry.short = short;
    let ident = camel(short);
    for (let n = 2; idents.has(ident); n++) ident = `${camel(short)}${n}`;
    idents.add(ident);
    entry.ident = ident;
  }

  fs.writeFileSync(path.join(root, ".deco", "index.ts"), renderBlockMap(root, entries));
  const aliases = entries.reduce((n, e) => n + e.legacy.length, 0);
  report.done.push({
    step: "block map",
    subject: ".deco/index.ts",
    message: `${entries.length} blocks, with ${aliases} aliases under their v7 names`,
  });
  if (entries.some((e) => e.kind === "section")) {
    report.manual.push({
      step: "block map",
      subject: ".deco/index.ts",
      message:
        "sections return descriptors ({ component, props }): add a view registry that maps each component name to its section (/next/rendering)",
    });
  }
  return { vendored };
}

function renderBlockMap(root: string, entries: Entry[]): string {
  const lines = [
    "// Generated by @decocms/blocks-migrate from a v7 site. It's your code now: edit it freely.",
    "// Each block has a short name plus an alias under every v7 name saved content stores",
    "// (see /next/renames-and-migrations).",
    'import type { Blocks, Route, Seo } from "@decocms/blocks";',
  ];
  for (const e of entries.filter((e) => e.kind === "function")) {
    lines.push(`import ${e.ident} from "${importPath(root, e.file)}";`);
  }
  lines.push(
    "",
    "/** What a section block returns: the component to render and its props (/next/rendering). */",
    "export interface BlockDescriptor {",
    "  component: string;",
    "  props: unknown;",
    "}",
    "",
    "/** A page with its blocks resolved. */",
    "export interface ResolvedPage extends Route {",
    "  seo?: Seo;",
    "  sections: BlockDescriptor[];",
    "}",
    "",
    "/** A v7 section's saved props: its loader's input when it has one, else its component's props. */",
    "type PropsOf<M> = M extends { loader: (props: infer P, ...rest: any[]) => unknown }",
    "  ? P",
    "  : M extends { default: (props: infer P, ...rest: any[]) => unknown }",
    "    ? P",
    "    : Record<string, never>;",
    "",
    "const section =",
    "  <M>(component: string) =>",
    "  (props: PropsOf<M>): BlockDescriptor => ({ component, props });",
    "",
  );
  for (const e of entries.filter((e) => e.kind === "section")) {
    lines.push(
      `const ${e.ident} = section<typeof import("${importPath(root, e.file)}")>(${JSON.stringify(e.short)});`,
    );
  }
  lines.push("", "export default {", "  page: (input: ResolvedPage) => input,");
  for (const e of entries) {
    lines.push(`  ${JSON.stringify(e.short)}: ${e.ident},`);
    for (const legacy of e.legacy) lines.push(`  ${JSON.stringify(legacy)}: ${e.ident},`);
  }
  lines.push("} satisfies Blocks;", "");
  return lines.join("\n");
}
