/**
 * The TanStack worker entry the migration writes (`src/worker-entry.ts`): the
 * site-owned page cache recipe from `@decocms/tanstack`'s README (the
 * worker caches no page itself), with what the site's v7
 * `createDecoWorkerEntry` call said: its `buildSegment` (the cache's split:
 * device, region, sales channel, `loggedIn`), its `csp` directives (sent
 * report-only, as v7 did by default), the imports and top-level declarations
 * those use, and the site's name. Everything else in the v7 entry (admin
 * handlers, `instrumentWorker`, `withABTesting`, a `proxyHandler`) is
 * reported: git has the old file.
 *
 * `RECIPE` is `examples/tanstack-worker-smoke/src/worker-entry.ts` byte for
 * byte (`workerEntry.test.ts`); after changing the example, copy it here.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Report } from "./report";

export const RECIPE = `/**
 * The Worker (wrangler.jsonc "main"): TanStack Start behind \`createDecoWorker\`
 * (drafts, Studio framing, CMS redirects, the visitor), with this site's own
 * page cache in front of the app: the Cloudflare Cache API, keyed by path,
 * device, the site's segment parts, the request's assignments and
 * \`<build>.<content revision>\`; v7's cache profiles; and v7's purge route,
 * \`POST /_cache/purge\`. The cache is this file's: change what it keys on,
 * how long it keeps a page, or drop it.
 */
import {
  assignmentsKey,
  CSEG_PARAM,
  cacheVersion,
  createDecoWorker,
  DEGRADED_HEADER,
  detectDevice,
  type ExecutionContextLike,
  isServerFnPath,
  liveAssignmentKeys,
  type PageRequest,
  type Segment,
  segmentKey,
  segmentToken,
  serverFnPagePath,
} from "@decocms/tanstack/worker";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { cms } from "./cms";

interface Env {
  /** The purge route's token (a Worker secret: \`wrangler secret put PURGE_TOKEN\`). */
  PURGE_TOKEN?: string;
}

// ---------------------------------------------------------------------------
// What splits the cache besides the path, the assignments and the version.
// ---------------------------------------------------------------------------

/**
 * The site's segment (v7's \`buildSegment\`): the device and the site's own
 * parts (a region, a sales channel), each in the key. \`loggedIn: true\` is a
 * signed-in shopper: never served from or stored in the cache.
 */
type SiteSegment = { device: string; loggedIn?: boolean } & Record<
  string,
  string | boolean | undefined
>;

const buildSegment: (request: Request) => SiteSegment = (request) => ({
  device: detectDevice(request.headers.get("user-agent") ?? ""),
});

/** The segment as key parts, or \`"private"\` for a request that never shares a cached page. */
function segmentOf(request: Request): Segment | "private" {
  const { loggedIn, ...parts } = buildSegment(request);
  if (loggedIn === true) return "private";
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parts)) {
    if (value !== undefined && value !== "" && value !== false) out[name] = String(value);
  }
  return out;
}

/** The segments a purge drops when its body names none: each device. */
const DEVICES: readonly Segment[] = [
  { device: "mobile" },
  { device: "tablet" },
  { device: "desktop" },
];

// ---------------------------------------------------------------------------
// Cache profiles: how long a page is kept, picked per URL (v7's values).
// ---------------------------------------------------------------------------

/** Seconds: \`fresh\` = served as is; \`swr\` = served stale while revalidating; \`sie\` = served stale when the app fails. */
interface CacheWindow {
  fresh: number;
  swr: number;
  sie: number;
}
interface CacheProfile {
  edge: CacheWindow;
  browser: CacheWindow;
  isPublic: boolean;
}
type ProfileName = "static" | "product" | "listing" | "search" | "private" | "none";

const NEVER: CacheWindow = { fresh: 0, swr: 0, sie: 0 };
const NO_CACHE: CacheProfile = { edge: NEVER, browser: NEVER, isPublic: false };
const PROFILES: Record<ProfileName, CacheProfile> = {
  static: {
    edge: { fresh: 900, swr: 7200, sie: 21600 },
    browser: { fresh: 120, swr: 1800, sie: 7200 },
    isPublic: true,
  },
  product: {
    edge: { fresh: 300, swr: 1800, sie: 7200 },
    browser: { fresh: 60, swr: 600, sie: 3600 },
    isPublic: true,
  },
  listing: {
    edge: { fresh: 120, swr: 900, sie: 3600 },
    browser: { fresh: 30, swr: 300, sie: 1800 },
    isPublic: true,
  },
  search: {
    edge: { fresh: 60, swr: 300, sie: 1800 },
    browser: { fresh: 0, swr: 120, sie: 600 },
    isPublic: true,
  },
  private: NO_CACHE,
  none: NO_CACHE,
};

const PRIVATE_NO_CACHE = "private, no-cache, no-store, must-revalidate";
const PRIVATE_PREFIX_RE = /^\\/(cart|checkout|account|login|my-account)(\\/|$)/;

/** A page URL's profile: the first rule that matches wins. */
function pageProfile(url: URL): ProfileName {
  const p = url.pathname;
  if (PRIVATE_PREFIX_RE.test(p)) return "private";
  if (p.startsWith("/api/") || p.startsWith("/deco/")) return "none";
  if (p === "/sitemap.xml" || p === "/") return "static";
  if (p === "/s" || p.startsWith("/s/") || url.searchParams.has("q")) return "search";
  if (p.endsWith("/p")) return "product";
  return "listing";
}

/** A request's profile: a GET server function takes its page's, any other one is private. */
function profileOf(url: URL): ProfileName {
  if (!isServerFnPath(url.pathname)) return pageProfile(url);
  const page = serverFnPagePath(url);
  return page ? pageProfile(new URL(page, url.origin)) : "private";
}

/** The browser's \`Cache-Control\` for a profile. */
function browserCacheControl(profile: CacheProfile): string {
  if (!profile.isPublic || (profile.edge.fresh === 0 && profile.browser.fresh === 0)) {
    return PRIVATE_NO_CACHE;
  }
  const { browser, edge } = profile;
  const parts = ["public", \`max-age=\${browser.fresh}\`];
  if (edge.fresh > 0) parts.push(\`s-maxage=\${edge.fresh}\`);
  if (browser.swr > 0) parts.push(\`stale-while-revalidate=\${browser.swr}\`);
  if (browser.sie > 0) parts.push(\`stale-if-error=\${browser.sie}\`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// The key: the same function for the lookup and the purge, so they match byte for byte.
// ---------------------------------------------------------------------------

/** Query parameters that never change a page, left out of the key (v7's list). */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utmi_campaign",
  "utmi_page",
  "utmi_part",
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "ttclid",
  "srsltid",
]);

/** Variant params a page load ignores, left out of a server function's key. */
const SERVER_FN_IGNORED_PARAMS = ["skuId", "idsku"];

/** A server function's payload for the key: page paths without the variant params. */
function canonicalPayload(payload: string): string {
  const strip = (s: string): string => {
    const q = s.indexOf("?");
    if (!s.startsWith("/") || s.startsWith("//") || q < 0) return s;
    const params = new URLSearchParams(s.slice(q + 1));
    for (const name of SERVER_FN_IGNORED_PARAMS) params.delete(name);
    const rest = params.toString();
    return rest ? \`\${s.slice(0, q)}?\${rest}\` : s.slice(0, q);
  };
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") return strip(v);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    }
    return v;
  };
  try {
    return JSON.stringify(visit(JSON.parse(payload)));
  } catch {
    return payload;
  }
}

interface KeyParts {
  /** \`<build>.<content revision>\` (\`cacheVersion\`). */
  version: string;
  segment: Segment;
  /** \`assignmentsKey\`: the tests the visitor is in and the campaigns running, never the visitor. */
  assigned: string;
  /** A programmatic fetch (\`Sec-Fetch-Dest: empty\`) of a page: its own entry, as in v7. */
  fetch: boolean;
}

function cacheKey(url: URL, parts: KeyParts): Request {
  const key = new URL(url);
  key.hash = "";
  for (const name of [...key.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(name.toLowerCase())) key.searchParams.delete(name);
  }
  key.searchParams.delete(CSEG_PARAM);
  const serverFn = isServerFnPath(key.pathname);
  const payload = key.searchParams.get("payload");
  if (serverFn && payload) key.searchParams.set("payload", canonicalPayload(payload));
  if (parts.version) key.searchParams.set("__v", parts.version);
  if (!serverFn && parts.fetch) key.searchParams.set("__fetch", "1");
  key.searchParams.set("__seg", segmentKey(parts.segment));
  if (parts.assigned) key.searchParams.set("__a", parts.assigned);
  return new Request(key.toString(), { method: "GET" });
}

// ---------------------------------------------------------------------------
// The page cache: createDecoWorker calls it for every page and server-function
// GET of the current release (never a preview, never in \`vite dev\`), and adds
// the visitor's first-visit cookie to whatever it answers, so a stored copy
// never carries one.
// ---------------------------------------------------------------------------

/** Cookies a cached page may set: stripped from the stored copy, the visitor still gets them. */
const SAFE_COOKIES = new Set(["_deco_bucket"]);
const STORED_AT = "X-Deco-Stored-At";

const cookieName = (setCookie: string) =>
  setCookie.slice(0, Math.max(0, setCookie.indexOf("="))).trim();

function edgeCache(): Cache | null {
  return typeof caches !== "undefined"
    ? ((caches as unknown as { default?: Cache }).default ?? null)
    : null;
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}

async function pageCache(page: PageRequest<Env>): Promise<Response> {
  const { request, url, ctx } = page;
  const profileName = profileOf(url);
  const profile = PROFILES[profileName];
  const segment = segmentOf(request);
  if (segment === "private" || !profile.isPublic || profile.edge.fresh === 0) {
    return withHeaders(await page.render(), {
      "Cache-Control": PRIVATE_NO_CACHE,
      "X-Cache": "BYPASS",
      "X-Cache-Reason": segment === "private" ? "private" : \`profile:\${profileName}\`,
    });
  }

  const version = await cacheVersion(cms, __BUILD_HASH__);
  // What the worker decided and the page renders: two visitors on the same side of every test share an entry.
  const assigned = assignmentsKey(page.assignments);
  const key = cacheKey(url, {
    version,
    segment,
    assigned,
    fetch: request.headers.get("sec-fetch-dest") === "empty",
  });
  // The token the document publishes: its navigation data may be kept by the CDN under it.
  const token = segmentToken(segment, assigned ? \`\${version}|\${assigned}\` : version);
  const render = () => page.render({ csegToken: token ?? undefined });
  const cdnPublic =
    token !== null && isServerFnPath(url.pathname) && url.searchParams.get(CSEG_PARAM) === token;
  const { edge } = profile;
  const cache = edgeCache();

  const dress = (response: Response, decision: string, extra: Record<string, string> = {}) => {
    const out = withHeaders(response, {
      "Cache-Control": browserCacheControl(profile),
      Vary: "Accept-Encoding",
      "CDN-Cache-Control": cdnPublic ? \`public, max-age=\${edge.fresh}\` : "no-store",
      "X-Cache": decision,
      "X-Cache-Profile": profileName,
      "X-Cache-Segment": segmentKey(segment),
      ...(version ? { "X-Cache-Version": version } : {}),
      ...extra,
    });
    // The Cache API adds its own status to a matched copy.
    out.headers.delete("cf-cache-status");
    out.headers.delete(STORED_AT);
    return out;
  };
  const isPrivate = (r: Response) =>
    /\\b(private|no-store)\\b/i.test(r.headers.get("cache-control") ?? "") ||
    r.headers.getSetCookie().some((c) => !SAFE_COOKIES.has(cookieName(c)));
  const isDegraded = (r: Response) => r.headers.get(DEGRADED_HEADER) === "true";
  const store = (response: Response) => {
    if (!cache) return;
    const copy = new Response(response.clone().body, response);
    copy.headers.delete("set-cookie");
    for (const c of response.headers.getSetCookie()) {
      if (!SAFE_COOKIES.has(cookieName(c))) copy.headers.append("set-cookie", c);
    }
    copy.headers.set(
      "Cache-Control",
      \`public, max-age=\${edge.fresh + Math.max(edge.swr, edge.sie)}\`,
    );
    copy.headers.set(STORED_AT, String(Date.now()));
    copy.headers.delete("CDN-Cache-Control");
    ctx.waitUntil(cache.put(key, copy).catch(() => {}));
  };
  const ageOf = (r: Response) => {
    const storedAt = Number(r.headers.get(STORED_AT) || "0");
    return storedAt > 0 ? (Date.now() - storedAt) / 1000 : Number.POSITIVE_INFINITY;
  };

  const cached = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (cached) {
    const age = ageOf(cached);
    if (age < edge.fresh) return dress(cached, "HIT");
    if (age < edge.fresh + edge.swr) {
      ctx.waitUntil(
        render()
          .then((fresh) => {
            if (fresh.status === 200 && !isDegraded(fresh) && !isPrivate(fresh)) store(fresh);
          })
          .catch(() => {}),
      );
      return dress(cached, "STALE-HIT", { "X-Cache-Age": String(Math.round(age)) });
    }
  }
  const staleOnError = (reason: string): Response | null => {
    if (!cached || ageOf(cached) >= edge.fresh + edge.sie) return null;
    return dress(cached, "STALE-ERROR", {
      "X-Cache-Age": String(Math.round(ageOf(cached))),
      "X-Cache-Reason": reason,
    });
  };

  let response: Response;
  try {
    response = await render();
  } catch (error) {
    const stale = staleOnError("origin-error");
    if (stale) return stale;
    throw error;
  }
  if (response.status !== 200) {
    const failed = response.status >= 500 || response.status === 429;
    const stale = failed ? staleOnError(\`origin-status:\${response.status}\`) : null;
    return (
      stale ??
      withHeaders(response, { "X-Cache": "BYPASS", "X-Cache-Reason": \`status:\${response.status}\` })
    );
  }
  if (isDegraded(response) || isPrivate(response)) {
    const stale = isDegraded(response) ? staleOnError("degraded") : null;
    return (
      stale ??
      withHeaders(response, {
        "Cache-Control": PRIVATE_NO_CACHE,
        "X-Cache": "BYPASS",
        "X-Cache-Reason": isDegraded(response) ? "degraded" : "private-response",
      })
    );
  }
  store(response);
  return dress(response, "MISS");
}

// ---------------------------------------------------------------------------
// Purge: v7's request, POST /_cache/purge with \`Authorization: Bearer <PURGE_TOKEN>\`
// and { "paths": ["/", "/shoes"], "segments"?: [{ "device": "desktop", ... }] }.
// ---------------------------------------------------------------------------

const PURGE_PATH = "/_cache/purge";

/** Constant-time compare (the token's length isn't secret). */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Drops each exact path (\`/shoes\` never drops \`/shoes?page=2\`) under the
 * current version, for every segment (the body's own, else each device),
 * every assignments key a visitor can carry now (each subset of the saved
 * tests, with the running campaigns and with none), as a navigation and a
 * programmatic fetch. Navigation data expires with its profile, as in v7.
 */
async function purge(request: Request, env: Env): Promise<Response> {
  const token = env.PURGE_TOKEN;
  if (!token || !sameString(request.headers.get("Authorization") ?? "", \`Bearer \${token}\`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  let body: { paths?: unknown; segments?: unknown };
  try {
    const parsed: unknown = await request.json();
    body = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const paths = Array.isArray(body.paths)
    ? [
        ...new Set(
          body.paths.filter((p): p is string => typeof p === "string" && p.startsWith("/")),
        ),
      ]
    : [];
  if (paths.length === 0) {
    return new Response('Body must include "paths": ["/", "/page"]', { status: 400 });
  }
  const segments = new Map<string, Segment>();
  for (const s of Array.isArray(body.segments) ? body.segments : DEVICES) {
    if (!s || typeof s !== "object") continue;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(s)) if (typeof v === "string" && v) clean[k] = v;
    segments.set(segmentKey(clean), clean);
  }
  const cache = edgeCache();
  if (!cache) return Response.json({ purged: [], total: 0, note: "Cache storage unavailable" });
  const origin = new URL(request.url).origin;
  const version = await cacheVersion(cms, __BUILD_HASH__);
  const assignments = await liveAssignmentKeys(cms);
  const purged: string[] = [];
  for (const [i, path] of paths.entries()) {
    const url = new URL(path, origin);
    for (const segment of segments.values()) {
      for (const assigned of assignments) {
        for (const fetch of [false, true]) {
          let gone: boolean;
          try {
            gone = await cache.delete(cacheKey(url, { version, segment, assigned, fetch }));
          } catch {
            // The Cache API is down, or the request's calls are spent (50 on Workers Free, 1,000 on Paid).
            return Response.json(
              {
                purged,
                notPurged: paths.slice(i),
                total: purged.length,
                note: "The Cache API stopped answering: send the notPurged paths again",
              },
              { status: 503 },
            );
          }
          if (gone) {
            const tags = [segmentKey(segment), assigned, fetch ? "fetch" : ""].filter(Boolean);
            purged.push(\`\${path} (\${tags.join(", ")})\`);
          }
        }
      }
    }
  }
  return Response.json({ purged, total: purged.length });
}

// ---------------------------------------------------------------------------
// The Worker.
// ---------------------------------------------------------------------------

const worker = createDecoWorker<Env>({
  serverEntry: createServerEntry({ fetch: handler.fetch }),
  cms,
  dev: import.meta.env.DEV,
  pageCache,
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname === PURGE_PATH) {
      return purge(request, env);
    }
    return worker.fetch(request, env, ctx);
  },
};
`;

/** What the recipe says by default, each replaced by what the site's v7 entry said. */
const DEFAULT_SEGMENT = `(request) => ({
  device: detectDevice(request.headers.get("user-agent") ?? ""),
})`;
const ANCHORS = {
  imports: 'import { cms } from "./cms";\n',
  declarations: "\ninterface Env {\n",
  segment: `const buildSegment: (request: Request) => SiteSegment = ${DEFAULT_SEGMENT};`,
  csp: "  dev: import.meta.env.DEV,\n",
} as const;

/** The names the recipe binds at the top level: a v7 import or declaration with one of them is left out. */
function recipeNames(): Set<string> {
  const file = ts.createSourceFile("recipe.ts", RECIPE, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const statement of file.statements) {
    for (const name of declaredNames(statement)) names.add(name);
  }
  return names;
}

export interface WorkerEntryParts {
  /** v7's `buildSegment`, as an expression of type `(request: Request) => SiteSegment`. */
  segment?: string;
  /** v7's `csp` directives, as an expression of type `string[]`. */
  csp?: string;
  /** Import declarations the segment and the CSP use, one per line. */
  imports?: string[];
  /** Top-level declarations the segment and the CSP use, in the v7 file's order. */
  declarations?: string[];
}

/** The recipe with the site's parts in it. */
export function workerEntryRecipe(parts: WorkerEntryParts): string {
  let out = RECIPE;
  const replace = (anchor: string, text: string) => {
    if (!out.includes(anchor))
      throw new Error(`the worker-entry recipe lost its anchor ${JSON.stringify(anchor)}`);
    out = out.replace(anchor, () => text);
  };
  if (parts.imports?.length) {
    replace(ANCHORS.imports, `${ANCHORS.imports}${parts.imports.map((i) => `${i}\n`).join("")}`);
  }
  if (parts.declarations?.length) {
    replace(ANCHORS.declarations, `\n${parts.declarations.join("\n\n")}\n${ANCHORS.declarations}`);
  }
  if (parts.segment !== undefined) {
    replace(ANCHORS.segment, ANCHORS.segment.replace(DEFAULT_SEGMENT, parts.segment));
  }
  if (parts.csp !== undefined) {
    replace(
      ANCHORS.csp,
      `${ANCHORS.csp}  // v7's csp, sent report-only as v7 did by default.\n  csp: { reportOnly: ${parts.csp} },\n`,
    );
  }
  return out;
}

function declaredNames(statement: ts.Statement): string[] {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return [];
    const names = clause.name ? [clause.name.text] : [];
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const e of bindings.elements) names.push(e.name.text);
    }
    return names;
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name.text] : [],
    );
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return [statement.name.text];
  }
  return [];
}

/** Every identifier under `node`. */
function identifiers(node: ts.Node, out = new Set<string>()): Set<string> {
  if (ts.isIdentifier(node)) out.add(node.text);
  node.forEachChild((child) => {
    identifiers(child, out);
  });
  return out;
}

/** The `createDecoWorkerEntry(serverEntry, { … })` call's options object. */
function v7Options(file: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createDecoWorkerEntry"
    ) {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) found = options;
      return;
    }
    node.forEachChild(visit);
  };
  visit(file);
  return found;
}

function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  return p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
    ? p.name.text
    : undefined;
}

/** A property's value as an expression: `buildSegment(request) { … }` becomes `function (request) { … }`. */
function valueText(p: ts.ObjectLiteralElementLike, file: ts.SourceFile): string | undefined {
  if (ts.isPropertyAssignment(p)) return p.initializer.getText(file);
  if (ts.isShorthandPropertyAssignment(p)) return p.name.text;
  if (ts.isMethodDeclaration(p) && p.body) {
    const params = p.parameters.map((x) => x.getText(file)).join(", ");
    return `${p.asteriskToken ? "function* " : "function "}(${params}) ${p.body.getText(file)}`;
  }
  return undefined;
}

/** The import declaration with only `keep`'s bindings, or `undefined` when none is left. */
function importWith(decl: ts.ImportDeclaration, keep: Set<string>, file: ts.SourceFile) {
  const clause = decl.importClause;
  if (!clause) return undefined;
  const spec = decl.moduleSpecifier.getText(file);
  const parts: string[] = [];
  if (clause.name && keep.has(clause.name.text)) parts.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings) && keep.has(bindings.name.text)) {
    parts.push(`* as ${bindings.name.text}`);
  }
  if (bindings && ts.isNamedImports(bindings)) {
    const named = bindings.elements
      .filter((e) => keep.has(e.name.text))
      .map((e) => e.getText(file));
    if (named.length) parts.push(`{ ${named.join(", ")} }`);
  }
  if (parts.length === 0) return undefined;
  return `import ${clause.isTypeOnly ? "type " : ""}${parts.join(", ")} from ${spec};`;
}

/** The parts of the recipe the v7 entry fills, and the v7 options it doesn't carry. */
export function v7WorkerEntryParts(
  text: string,
): { parts: WorkerEntryParts; leftOut: string[] } | undefined {
  const file = ts.createSourceFile("worker-entry.ts", text, ts.ScriptTarget.Latest, true);
  const options = v7Options(file);
  if (!options) return undefined;
  const parts: WorkerEntryParts = {};
  const leftOut: string[] = [];
  const used = new Set<string>();
  for (const p of options.properties) {
    const name = propertyName(p);
    const value = valueText(p, file);
    if (name === "buildSegment" && value !== undefined) parts.segment = value;
    else if (name === "csp" && value !== undefined && value !== "false") parts.csp = value;
    else if (name !== undefined && name !== "observability" && name !== "admin") leftOut.push(name);
    if ((name === "buildSegment" || name === "csp") && value !== undefined) {
      identifiers(ts.isPropertyAssignment(p) ? p.initializer : p, used);
    }
  }
  const taken = recipeNames();
  // The top-level declarations the carried code uses, and the ones those use.
  const declarations = file.statements.filter(
    (s) => !ts.isImportDeclaration(s) && !s.getText(file).includes("createDecoWorkerEntry"),
  );
  const kept = new Set<ts.Statement>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of declarations) {
      if (kept.has(s)) continue;
      const names = declaredNames(s);
      if (
        names.length === 0 ||
        names.some((n) => taken.has(n)) ||
        !names.some((n) => used.has(n))
      ) {
        continue;
      }
      kept.add(s);
      identifiers(s, used);
      grew = true;
    }
  }
  parts.declarations = declarations.filter((s) => kept.has(s)).map((s) => s.getText(file));
  parts.imports = file.statements
    .filter(ts.isImportDeclaration)
    .map((d) => {
      const keep = new Set(declaredNames(d).filter((n) => used.has(n) && !taken.has(n)));
      return importWith(d, keep, file);
    })
    .filter((i): i is string => i !== undefined);
  return { parts, leftOut };
}

/** The worker entry wrangler runs: its `main`, else `src/worker-entry.ts`. */
function workerEntryFile(root: string): string {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const main = fs.readFileSync(file, "utf8").match(/"main"\s*:\s*"([^"]+)"/)?.[1];
    if (main && /\.(ts|tsx|js|mjs)$/.test(main)) return path.join(root, main);
  }
  return path.join(root, "src", "worker-entry.ts");
}

/**
 * Writes the TanStack worker entry: the recipe, with what the v7
 * `createDecoWorkerEntry` call carried. An entry that isn't v7's is kept and
 * reported.
 */
export function writeWorkerEntry(root: string, report: Report): void {
  const file = workerEntryFile(root);
  const rel = path.relative(root, file).split(path.sep).join("/");
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  const fromV7 = old === undefined ? undefined : v7WorkerEntryParts(old);
  if (old !== undefined && fromV7 === undefined) {
    report.manual.push({
      step: "scaffold",
      subject: rel,
      message:
        "isn't a v7 createDecoWorkerEntry call, so it was kept: the worker caches no page, so wire createDecoWorker with the site's own pageCache as the worker-entry recipe in @decocms/tanstack's README does",
    });
    return;
  }
  const parts = fromV7?.parts ?? {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, workerEntryRecipe(parts));
  declareBuildHash(root, report);
  const carried = [
    parts.segment !== undefined ? "v7's buildSegment" : undefined,
    parts.csp !== undefined ? "v7's csp (report-only)" : undefined,
  ].filter(Boolean);
  report.done.push({
    step: "scaffold",
    subject: rel,
    message: `${old === undefined ? "written" : "replaced"}: createDecoWorker with the site's own page cache in front of it (the Cache API, v7's cache profiles, a key on path, device, the segment, the assignments and the build and content version, and v7's POST /_cache/purge with the PURGE_TOKEN secret)${carried.length ? `, carrying ${carried.join(" and ")}` : ""}`,
  });
  if (fromV7 && fromV7.leftOut.length > 0) {
    report.manual.push({
      step: "scaffold",
      subject: rel,
      message: `v7's createDecoWorkerEntry options not carried: ${fromV7.leftOut.join(", ")}. Move what the site still needs from git (a proxyHandler becomes createDecoWorker's routes; securityHeaders and cspMode its csp; purgeTokenEnv the recipe's env.PURGE_TOKEN; a cache profile change the recipe's PROFILES); wrappers around the v7 worker (instrumentWorker, withABTesting) are gone with it: see the import map`,
    });
  }
}

const BUILD_HASH_DECLARATION = /declare\s+const\s+__BUILD_HASH__\b/;

/** `__BUILD_HASH__` (`decoTanstack()`'s define) declared once for the recipe's key, unless the site does. */
function declareBuildHash(root: string, report: Report): void {
  const src = path.join(root, "src");
  const declared = fs
    .readdirSync(src, { recursive: true, withFileTypes: true })
    .some(
      (d) =>
        d.isFile() &&
        /\.tsx?$/.test(d.name) &&
        BUILD_HASH_DECLARATION.test(fs.readFileSync(path.join(d.parentPath, d.name), "utf8")),
    );
  if (declared) return;
  const file = path.join(src, "build-hash.d.ts");
  fs.writeFileSync(
    file,
    "/** The build's id, defined by `decoTanstack()` from `@decocms/tanstack/vite`: in every page cache key. */\ndeclare const __BUILD_HASH__: string;\n",
  );
  report.done.push({
    step: "scaffold",
    subject: "src/build-hash.d.ts",
    message:
      "declares __BUILD_HASH__, the build id decoTanstack() defines, which the worker entry's cache key reads",
  });
}
