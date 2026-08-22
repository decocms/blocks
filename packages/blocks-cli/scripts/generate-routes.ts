#!/usr/bin/env -S npx tsx
/**
 * Emits `.deco/routes.gen.ts` — the CMS page table, compiled for a device.
 *
 * The page tree is already data: `.deco/blocks/pages-*.json`, the files Studio
 * writes. So a native app does not need a second router, and it does not need
 * to re-declare routes — it needs this table.
 *
 * The load-bearing reason it is generated rather than read at runtime: CMS
 * paths are **URLPattern** syntax, and `matchPath` (`@decocms/blocks`) throws
 * on a runtime without the `URLPattern` Web API. Hermes does not have it. This
 * runs in Node, which does, and emits plain regex sources instead.
 *
 * Consumed by `createRoutePolicy` (`@decocms/native`). The table is a snapshot,
 * never a whitelist: an unmatched path must fall through to the WebView so a
 * page published after the build still opens.
 *
 * Usage:
 *   tsx generate-routes.ts [--blocks-dir .deco/blocks] [--out .deco/routes.gen.ts]
 */

import fs from "node:fs";
import path from "node:path";

interface RouteEntry {
  path: string;
  name: string;
  params: string[];
  pattern: string;
  /** Expo Router shape, as a starting point for the app's `native` map. */
  expo: string;
}

const RE_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * URLPattern → RegExp source.
 *
 * Handles what real decofiles use: `:param`, a trailing `*`, and literals.
 * Returns null for anything else — notably optional groups (`{/70-off}?`),
 * which have no Expo Router equivalent anyway. Those pages fall through to the
 * WebView, which is the correct default.
 */
export function patternToRegex(urlPattern: string): { pattern: string; params: string[] } | null {
  // Optional/named groups and regex modifiers are out of scope on purpose.
  if (/[{}()]/.test(urlPattern)) return null;

  const params: string[] = [];
  let source = "^";

  for (const segment of urlPattern.split("/")) {
    if (segment === "") continue;
    source += "/";

    if (segment === "*") {
      // Catch-all: matches the rest of the path, including further slashes.
      params.push("_");
      source += "(.*)";
      continue;
    }

    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
      params.push(name);
      source += "([^/]+)";
      continue;
    }

    if (segment.includes(":") || segment.includes("*")) return null; // mixed segment
    source += segment.replace(RE_SPECIALS, "\\$&");
  }

  // Tolerate a trailing slash; `/` itself must not match everything.
  source += source === "^" ? "/?$" : "/?$";
  return { pattern: source, params };
}

/** `/products/:slug` → `/products/[slug]`. Purely a suggestion for the app. */
function toExpo(urlPattern: string): string {
  return urlPattern
    .split("/")
    .map((s) => (s.startsWith(":") ? `[${s.slice(1)}]` : s === "*" ? "[...rest]" : s))
    .join("/");
}

/**
 * Sorts by specificity so `/products/:slug` is tried before `/*`.
 * More static segments first; among equals, fewer params first.
 */
function bySpecificity(a: RouteEntry, b: RouteEntry): number {
  const statics = (r: RouteEntry) =>
    r.path.split("/").filter((s) => s && !s.startsWith(":") && s !== "*").length;
  const diff = statics(b) - statics(a);
  if (diff !== 0) return diff;
  if (a.params.length !== b.params.length) return a.params.length - b.params.length;
  return a.path.localeCompare(b.path);
}

export function collectRoutes(blocksDir: string): RouteEntry[] {
  if (!fs.existsSync(blocksDir)) return [];

  const entries: RouteEntry[] = [];
  const skipped: Array<{ path: string; why: string }> = [];

  for (const file of fs.readdirSync(blocksDir)) {
    if (!file.endsWith(".json")) continue;
    // Page blocks are keyed `pages-*` by the decofile convention.
    if (!decodeURIComponent(file).startsWith("pages-")) continue;

    let block: { path?: string; name?: string };
    try {
      block = JSON.parse(fs.readFileSync(path.join(blocksDir, file), "utf8"));
    } catch {
      continue; // A malformed block is the blocks generator's problem to report.
    }
    if (!block.path) continue;

    const compiled = patternToRegex(block.path);
    if (!compiled) {
      skipped.push({ path: block.path, why: "unsupported URLPattern syntax" });
      continue;
    }

    entries.push({
      path: block.path,
      name: block.name ?? block.path,
      params: compiled.params,
      pattern: compiled.pattern,
      expo: toExpo(block.path),
    });
  }

  // Never silently drop coverage — a skipped route is a page that will only
  // ever open in the WebView, and someone should know which.
  for (const s of skipped) {
    console.warn(`  skipped ${s.path} — ${s.why} (falls back to WebView)`);
  }

  // De-dupe by path: several page blocks can share one path (A/B variants).
  const byPath = new Map<string, RouteEntry>();
  for (const entry of entries) if (!byPath.has(entry.path)) byPath.set(entry.path, entry);

  return [...byPath.values()].sort(bySpecificity);
}

export function renderRoutesModule(routes: RouteEntry[]): string {
  const body = routes
    .map(
      (r) =>
        `  {\n    path: ${JSON.stringify(r.path)},\n    name: ${JSON.stringify(r.name)},\n` +
        `    params: ${JSON.stringify(r.params)},\n    pattern: ${JSON.stringify(r.pattern)},\n  },`,
    )
    .join("\n");

  const suggestions = routes.map(
    (r) => `//   ${JSON.stringify(r.path)}: ${JSON.stringify(r.expo)},`,
  );

  return `// AUTO-GENERATED by @decocms/blocks-cli generate-routes.ts — do not edit.
//
// The CMS page table, compiled from .deco/blocks/. Paths are URLPattern in the
// decofile; they are compiled to plain regex here because Hermes has no
// URLPattern API.
//
// This is a SNAPSHOT, not a whitelist. Feed it to createRoutePolicy and leave
// WebView as the fallback, so a page published after this build still opens.
//
// Opt a page into a native screen by adding it to the policy's \`native\` map:
//
// createRoutePolicy({
//   routes: cmsRoutes,
//   native: {
${suggestions.join("\n")}
//   },
// });

export interface CmsRoute {
  path: string;
  name: string;
  params: string[];
  pattern: string;
}

export const cmsRoutes: CmsRoute[] = [
${body}
];
`;
}

function parseArgs(argv: string[]) {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    blocksDir: get("--blocks-dir", path.join(".deco", "blocks")),
    out: get("--out", path.join(".deco", "routes.gen.ts")),
  };
}

async function main() {
  const { blocksDir, out } = parseArgs(process.argv.slice(2));
  const routes = collectRoutes(path.resolve(blocksDir));
  const contents = renderRoutesModule(routes);

  await fs.promises.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  // Write-if-changed keeps the incremental digest stable.
  const existing = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
  if (existing !== contents) await fs.promises.writeFile(out, contents);

  console.log(`Generated ${routes.length} CMS routes → ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
