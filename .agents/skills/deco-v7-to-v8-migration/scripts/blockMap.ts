/**
 * The block map (spec: renames-and-migrations › Rename a block type). Saved
 * content names v7 types by file path, like `site/sections/Product/Shelf.tsx`;
 * the next major resolves a name only through `.deco/index.ts`. This step
 * writes that file: one entry per v7 name the content stores (and per section
 * in `src/sections`), so the content keeps resolving. No short names: the
 * site editor lists every name, so a block under two would be offered twice
 * (PO 2026-10-15).
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
import { type Framework, siteBlocksVersion, siteFramework } from "./framework";
import { matcherEntry, V7_MATCHER_HINT, v7Matcher } from "./matchers";
import type { Report } from "./report";
import type { SectionLoaderWiring } from "./sectionLoaders";
import { firstFile, locateAppModule, vendorModule } from "./vendor";
import { forEachBlock, readContent } from "./walk";

type Kind = "section" | "function";

interface Entry {
  /** The module that holds the block function (default export). */
  file: string;
  kind: Kind;
  /** The v7 names content stores for it: the names it's registered under. */
  legacy: string[];
  ident: string;
  /** Whether the module exports a `loader` (a section's, run by `loadSections`). */
  loader: boolean;
  /** A section's descriptor `component`: its v7 type name, `site/sections/….tsx`. */
  component: string;
}

const ANALYTICS_SECTION = /^website\/sections\/Analytics\//;

/** Where to look for a type without a v8 equivalent. */
const HINTS: [RegExp, string][] = [
  [
    /\/apps\//,
    "a v7 app block; the next major has no apps: create the platform's client in code with these settings (/next/upstream-clients#call-a-client), then delete the saved block",
  ],
  [
    /^website\/sections\/Rendering\/(Lazy|Deferred|SingleDeferred)\.tsx?$/,
    "a v7 async-rendering wrapper the migration couldn't unwrap (no section, or several where one block goes); the next major has no async rendering: replace it with its section(s) in the content",
  ],
  [
    /\/sections\/Seo\//,
    "an SEO section: register a block under this name. In a page's seo field it returns the block map's own PageSeo type (.deco/index.ts), the fields the page's head shows: an all-optional field takes only blocks that return that same named type, so a copy of it doesn't fit; in sections, a descriptor or nothing. v7's SeoV2 also merged the website app's seo settings (defaults, titleTemplate, descriptionTemplate) into its fields, and v7's head took fields from sections registered with registerSeoSections too: carry those into the block (/next/renames-and-migrations#rename-a-type-with-an-alias)",
  ],
  [
    ANALYTICS_SECTION,
    "v7's Analytics section: move its tag IDs into your template's tag-manager block (/next/renames-and-migrations#telemetry-and-analytics)",
  ],
  [/\/matchers\//, V7_MATCHER_HINT],
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

/**
 * Write `.deco/index.ts` from the site's content and sources, and the view
 * registry `src/views.ts`. Keeps an existing block map. `wiring` says where
 * the site's v7 section loaders are exported now (./sectionLoaders.ts).
 */
export function writeBlockMap(
  root: string,
  report: Report,
  wiring: SectionLoaderWiring = {},
  /** v7 app types the apps step turned into client code (./apps.ts): not reported again. */
  apps: ReadonlySet<string> = new Set(),
): BlockMapResult {
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
  /** v7 Analytics sections' GTM/GA4 IDs, so the report carries them over. */
  const tagIds = new Map<string, Set<string>>();
  for (const [entry, block] of Object.entries(blocks)) {
    forEachBlock(block, (node) => {
      const type = node.__resolveType;
      if (!used.has(type)) used.set(type, new Set());
      used.get(type)!.add(files[entry]);
      if (!ANALYTICS_SECTION.test(type)) return;
      for (const field of ["trackingIds", "googleAnalyticsIds"]) {
        const ids = node[field];
        if (!Array.isArray(ids)) continue;
        if (!tagIds.has(type)) tagIds.set(type, new Set());
        for (const id of ids) if (typeof id === "string" && id) tagIds.get(type)!.add(id);
      }
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

  const framework = siteFramework(root);
  const byFile = new Map<string, Entry>();
  /** v7 matchers registered from @decocms/compat-v7/matchers: v7 name → the matcher. */
  const matchers = new Map<string, string>();
  const vendored = new Map<string, string>();
  const leave = (type: string, hint: string) => {
    const ids = [...(tagIds.get(type) ?? [])];
    const message = ids.length > 0 ? `${hint}; its tag IDs: ${ids.join(", ")}` : hint;
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
        if (!apps.has(type)) leave(type, hintFor(type));
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
      const matcher = v7Matcher(type);
      if (matcher && matcher !== "environment" && framework) {
        matchers.set(type, matcher);
        continue;
      }
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
    const component = `site/${posix(path.relative(path.join(root, "src"), file))}`;
    const loader = kind === "section" && HAS_LOADER.test(source);
    byFile.set(file, { file, kind, legacy: [type], ident: "", component, loader });
    if (loader && !wiring.loaders?.keys?.has(component)) {
      report.manual.push({
        step: "block map",
        subject: type,
        message:
          wiring.loaders?.keys === null
            ? "its loader now runs (loadSections in .deco/index.ts), unless the site's sectionLoaders lists it, which then runs instead: v7 ran a section's loader only when registerSectionLoaders listed it, and the script couldn't read that list's names. Where v7 didn't list it, v7 rendered its saved props and v8 runs the loader, an approved difference (PO 2026-10-15): list it in the PR"
            : "its loader now runs (loadSections in .deco/index.ts), which v7 never did: registerSectionLoaders didn't list it, so v7 rendered its saved props (the loader's input). The migration wires every section loader, an approved difference (PO 2026-10-15): list it in the PR",
      });
    }
    if (group === "actions") {
      leave(
        type,
        "an action: block functions should only read; call it from a server function or route handler instead (/next/renames-and-migrations#loaders-actions-and-invoke)",
      );
    }
  }

  // Identifiers: the file's name, then its path, then a number.
  const taken = new Set<string>();
  const idents = new Set<string>([
    "section",
    "PropsOf",
    "matchers",
    "matcherContext",
    "matcherInput",
    "matchPage",
    "pageUrls",
    "getRequest",
    "runSectionLoaders",
    "loadSections",
    "sectionLoaders",
    "nonCriticalSections",
    "views",
    "SectionView",
    "ComponentType",
    "loaders",
  ]);
  const entries = [...byFile.values()];
  for (const entry of entries) {
    const type = entry.legacy[0];
    const segments = type.split("/");
    const prefix = segments[0] === "site" ? "" : `${segments[0]}-`;
    const candidates = [
      prefix + kebab(segments.at(-1)!),
      prefix + kebab(segments.slice(2).join("-")),
    ];
    let base = candidates.find((c) => c && !taken.has(c));
    for (let n = 2; !base; n++)
      if (!taken.has(`${candidates[1]}-${n}`)) base = `${candidates[1]}-${n}`;
    taken.add(base);
    let ident = camel(base);
    const free = (id: string) => !idents.has(id) && !(entry.loader && idents.has(`${id}Loader`));
    for (let n = 2; !free(ident); n++) ident = `${camel(base)}${n}`;
    idents.add(ident);
    if (entry.loader) idents.add(`${ident}Loader`);
    entry.ident = ident;
  }

  const version = siteBlocksVersion(root);
  fs.writeFileSync(
    path.join(root, ".deco", "index.ts"),
    renderBlockMap(root, entries, { framework, matchers, wiring, version }),
  );
  const aliases = entries.reduce((n, e) => n + e.legacy.length, 0);
  report.done.push({
    step: "block map",
    subject: ".deco/index.ts",
    message: `${entries.length} blocks under their ${aliases} v7 names (no short names, so the site editor lists each once)${matchers.size > 0 ? `, and v7's ${[...new Set(matchers.values())].sort().join(", ")} matchers from @decocms/compat-v7/matchers` : ""}`,
  });
  const sections = entries.filter((e) => e.kind === "section");
  if (sections.length > 0) writeViews(root, sections, report);
  if (wiring.loaders || entries.some((e) => e.loader)) {
    report.manual.push({
      step: "block map",
      subject: "loadSections (.deco/index.ts)",
      message: `run the section loaders as v7 ran its registered ones: after the page resolved, call loadSections(sections, request, pageUrl) on every section of the page, the site's globals included, and render what it returns${framework === "tanstack" ? "; in the page's server function, pass the page's URL (the request is the server-function call on a client-side navigation)" : framework === "nextjs" ? "; on Next.js build the request from next/headers at the page's URL" : ""}. When degraded isn't empty, send X-Deco-Degraded: 1 and don't cache the page, as v7 did`,
    });
  }
  if (matchers.size > 0) reportMatchers(framework!, new Set(matchers.values()), report);
  return { vendored };
}

/** What the site wires around v7's matchers, by binding. */
function reportMatchers(framework: Framework, used: Set<string>, report: Report): void {
  const random = used.has("random");
  const message =
    framework === "tanstack"
      ? `call matchPage(href) from .deco/index.ts in the page's server function before resolving the page${random ? ", then commitSegmentCookie() from @decocms/compat-v7/tanstack/server once its blocks resolved (await them: the cookie is a response header), and give createDecoWorker segment: (request) => ({ ...cohortSegment(request) }), so the sticky A/B groups (latest 7.x) keep their cookie and their own cached page" : ""}`
      : `forward the page's URL in proxy.ts with pageUrlRequestHeaders from @decocms/compat-v7/nextjs/proxy, so the matchers read the page${random ? ", and render <SegmentCookie /> from @decocms/compat-v7/nextjs/server as the page's last child, so the sticky A/B groups (latest 7.x) keep their cookie" : ""}`;
  report.manual.push({ step: "block map", subject: "v7 matchers (.deco/index.ts)", message });
}

/** `src/views.ts`: each section descriptor's component → the module that renders it. */
function writeViews(root: string, sections: Entry[], report: Report): void {
  const existing = ["views.ts", "views.tsx"].find((f) => fs.existsSync(path.join(root, "src", f)));
  if (existing) {
    report.manual.push({
      step: "block map",
      subject: `src/${existing}`,
      message:
        "already exists, so it was kept: it must map each section's v7 type name (the descriptor's component) to its module",
    });
    return;
  }
  const from = (file: string) => {
    const rel = posix(path.relative(path.join(root, "src"), file)).replace(/\.tsx?$/, "");
    return rel.startsWith(".") ? rel : `./${rel}`;
  };
  const sorted = [...sections].sort((a, b) => (a.component < b.component ? -1 : 1));
  const lines = [
    "/**",
    " * The view registry (/next/rendering): the section each descriptor's `component` names, by its",
    " * v7 type name. Generated by the deco-v7-to-v8-migration skill with .deco/index.ts. It's your code now.",
    " */",
    'import type { ComponentType } from "react";',
    ...sorted.map((e) => `import * as ${e.ident} from "${from(e.file)}";`),
    "",
    "export interface SectionView {",
    "  default: ComponentType<any>;",
    "}",
    "",
    "export const views: Record<string, SectionView> = {",
    ...sorted.map((e) => `  ${JSON.stringify(e.component)}: ${e.ident},`),
    "};",
    "",
  ];
  fs.writeFileSync(path.join(root, "src", "views.ts"), lines.join("\n"));
  report.done.push({
    step: "block map",
    subject: "src/views.ts",
    message: `the view registry: ${sections.length} sections by their v7 type names; render each descriptor with views[component].default and its props (/next/rendering)`,
  });
}

interface RenderOptions {
  framework: Framework | undefined;
  /** v7 name → matcher, from @decocms/compat-v7/matchers. */
  matchers: Map<string, string>;
  wiring: SectionLoaderWiring;
  /** The site's 7.x version: the nested-section walk of its section loaders. */
  version: string | undefined;
}

/** v7 walked nested sections for their loaders at any depth from 7.77.13, only directly before. */
function nestedWalk(version: string | undefined): "deep" | "direct" {
  const [major, minor, patch] = (version ?? "").split(".").map(Number);
  if (major !== 7 || Number.isNaN(minor)) return "deep";
  return minor > 77 || (minor === 77 && patch >= 13) ? "deep" : "direct";
}

function renderBlockMap(root: string, entries: Entry[], options: RenderOptions): string {
  const { framework, matchers, wiring, version } = options;
  const lines = [
    "// Generated by the deco-v7-to-v8-migration skill from a v7 site. It's your code now: edit it freely.",
    "// Each block is registered under the v7 names saved content stores, and only those, so the site",
    "// editor lists it once (see /next/renames-and-migrations).",
    'import type { Blocks, Route } from "@decocms/blocks";',
  ];
  if (matchers.size > 0) {
    if (framework === "tanstack")
      lines.push('import { getRequest } from "@tanstack/react-start/server";');
    lines.push('import * as matchers from "@decocms/compat-v7/matchers";');
    lines.push(`import { matcherContext } from "@decocms/compat-v7/${framework}/server";`);
  }
  const fileSpecifier = (file: string) => importPath(root, file).replace(/\/index$/, "");
  // The loaders v7 never ran (all of them when its map's names can't be read: the map wins).
  const withLoader = entries.filter((e) => e.loader && !wiring.loaders?.keys?.has(e.component));
  const runsLoaders = wiring.loaders !== undefined || withLoader.length > 0;
  if (runsLoaders) {
    lines.push(
      'import { type RunSectionLoadersOptions, runSectionLoaders } from "@decocms/compat-v7/sections";',
    );
  }
  for (const e of withLoader) {
    lines.push(`import { loader as ${e.ident}Loader } from "${importPath(root, e.file)}";`);
  }
  if (wiring.loaders) {
    lines.push(`import { sectionLoaders } from "${fileSpecifier(wiring.loaders.file)}";`);
    if (wiring.nonCritical) {
      lines.push(
        `import { nonCriticalSections } from "${fileSpecifier(wiring.nonCritical.file)}";`,
      );
    }
  }
  for (const e of entries.filter((e) => e.kind === "function")) {
    lines.push(`import ${e.ident} from "${importPath(root, e.file)}";`);
  }
  lines.push(
    "",
    "/** What a section block returns: the component to render (its v7 type name) and its props (/next/rendering). */",
    "export interface BlockDescriptor {",
    "  component: string;",
    "  /** JSON from content and loader results. Loose, so a page's loader data can carry it to the browser. */",
    "  // biome-ignore lint/suspicious/noExplicitAny: each view types its own props",
    "  props: Record<string, any>;",
    "}",
    "",
    "/**",
    " * v7's page SEO: the fields its SEO sections returned and the page's head shows (src/page-view.tsx on",
    " * TanStack Start, generateMetadata on Next.js). Every field is optional; an SEO block returns this.",
    " */",
    "export interface PageSeo {",
    "  title?: string;",
    "  description?: string;",
    "  titleTemplate?: string;",
    "  descriptionTemplate?: string;",
    "  image?: string;",
    "  canonical?: string;",
    "  noIndexing?: boolean;",
    "  type?: string;",
    "  // biome-ignore lint/suspicious/noExplicitAny: JSON-LD objects",
    "  jsonLDs?: Record<string, any>[];",
    "}",
    "",
    "/** A page with its blocks resolved. */",
    "export interface ResolvedPage extends Route {",
    "  seo?: PageSeo;",
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
    "  (props: PropsOf<M>): BlockDescriptor => ({ component, props: props as Record<string, any> });",
    "",
  );
  for (const e of entries.filter((e) => e.kind === "section")) {
    lines.push(
      `const ${e.ident} = section<typeof import("${importPath(root, e.file)}")>(${JSON.stringify(e.component)});`,
    );
  }
  if (runsLoaders) {
    const nested = nestedWalk(version);
    lines.push(
      ...(withLoader.length > 0
        ? [
            "",
            "/** A section module's loader as the runner calls it: (props, request), never a v7 ctx. */",
            "const own = (",
            "  loader: (props: any, req: Request, ...rest: any[]) => unknown,",
            '): RunSectionLoadersOptions["loaders"][string] => loader;',
          ]
        : []),
      "",
      "/**",
      " * The section loaders, by v7 type name. v7 ran only those its registerSectionLoaders map listed; the",
      ` * migration also runs every other section's own loader (an approved difference, PO 2026-10-15)${wiring.loaders ? "," : "."}`,
      ...(wiring.loaders
        ? [" * and the site's sectionLoaders, v7's map, win where they list a section."]
        : []),
      " */",
      'const loaders: RunSectionLoadersOptions["loaders"] = {',
      ...withLoader.map((e) => `  ${JSON.stringify(e.component)}: own(${e.ident}Loader),`),
      ...(wiring.loaders ? ["  ...sectionLoaders,"] : []),
      "};",
      "",
      "/**",
      " * The section loaders over a page's sections, as v7 ran its registered ones after the",
      " * page resolved: run it once per page, on every section, globals included. `url` is the page's when the",
      " * request isn't for the page (a server-function call on a client-side navigation).",
      nested === "direct"
        ? ` * Nested sections run theirs only directly in a prop, as v7 ${version} did (7.77.13 walks any depth).`
        : " * Nested sections run theirs wherever they sit, as the latest 7.x does.",
      " */",
      "export function loadSections<S extends BlockDescriptor>(",
      "  sections: readonly S[],",
      "  request: Request,",
      "  url?: string | URL,",
      ") {",
      "  return runSectionLoaders(sections, {",
      "    loaders,",
      "    request,",
      "    url,",
      ...(wiring.nonCritical ? ["    nonCritical: nonCriticalSections,"] : []),
      ...(nested === "direct" ? ['    nested: "direct",'] : []),
      "  });",
      "}",
    );
  }
  if (matchers.size > 0 && framework === "tanstack") {
    lines.push(
      "",
      "/** The page each request opens, for v7's matchers (see matchPage). */",
      "const pageUrls = new WeakMap<Request, string>();",
      "",
      "/**",
      " * Tells v7's matchers which page this request opens: call it in the page's server function before",
      " * resolving the page. On a client-side navigation the request is the server-function call, and v7",
      " * matched the page being opened.",
      " */",
      "export function matchPage(url: string | URL, request: Request = getRequest()): void {",
      "  pageUrls.set(request, new URL(String(url), request.url).href);",
      "}",
      "",
      "/** What v7's matchers read: the page's URL, the request's headers and its A/B decisions. */",
      "const matcherInput = () => {",
      "  const request = getRequest();",
      "  return matcherContext(pageUrls.get(request), request);",
      "};",
    );
  }
  lines.push("", "export default {", "  page: (input: ResolvedPage) => input,");
  for (const e of entries) {
    for (const legacy of e.legacy) lines.push(`  ${JSON.stringify(legacy)}: ${e.ident},`);
  }
  if (matchers.size > 0) {
    lines.push("  // v7's matchers, with v7's results (@decocms/compat-v7/matchers)");
    for (const [type, matcher] of [...matchers].sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.push(`  ${JSON.stringify(type)}: ${matcherEntry(matcher, framework!)},`);
    }
  }
  lines.push("} satisfies Blocks;", "");
  return lines.join("\n");
}
