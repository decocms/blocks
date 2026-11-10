/**
 * Draft previews (see /next/content-delivery#draft-previews): what a draft
 * pointer names, how the SDK reads it and how a draft is laid over production.
 *
 * - The pointer's host must fall under one of the draft hosts (the same rule
 *   as v7's preview API domains): by default `*.decocms.com` (Studio, the
 *   delivery CDN, `local.studio.decocms.com`) and the loopback hosts;
 *   `createCMS({ preview: { draftHosts } })` replaces the list. Any other host
 *   is refused before anything is fetched.
 * - The pointer's path is a draft folder's index,
 *   `/sites/<site>/drafts/<slug>/index.json` (`{ names: [...] }`, the names
 *   the draft holds); a path that doesn't end in `/index.json` fails. Its
 *   version is opaque (it changes with every save, so the preview reloads).
 * - A draft read is one wave: the draft index, then every file it names
 *   (`<folder><file>`, the file being the name's `encodeURIComponent` plus
 *   `.json`, `index` written `%69ndex.json`), in parallel, plain GETs with no
 *   `If-None-Match` (nothing read from `drafts/` is kept across requests).
 *   Every GET carries a fresh `?r=<nonce>` the bucket ignores, so no shared
 *   cache can answer it: a CDN keeps a 404 (it has no `Cache-Control`) for
 *   minutes, and a file read once before its save landed would otherwise
 *   read as missing long after it exists (the draft silently showing
 *   production for that block). The scheme comes from the domain
 *   that admitted the host, never from the pointer: plain `http` only for
 *   loopback hosts. No cookies or credentials are sent, and redirects aren't
 *   followed (a response that was redirected anyway is refused). Each read has
 *   10 s and up to 16 MiB.
 * - A file is `{ operation: "set", data }` (the block), `{ operation:
 *   "delete" }` or `{ operation: "published" }` (a marker publish leaves). A
 *   missing file (404) or a `published` marker means the name isn't in the
 *   draft: the file is the truth, never the draft index. A file that doesn't
 *   parse fails the read.
 * - The overlay replaces a published entry with each `set` (its `meta` from
 *   `blockMeta`, its body held by the request) and removes each `delete`.
 */

import { type BlockIndex, blockMeta, type IndexEntry } from "./blockMeta.ts";
import { readBoundedJson, timeoutSignal } from "./boundedJson.ts";
import type { HeldBodies, IndexedContent } from "./contentIndex.ts";
import { isPlainObject, type JsonObject } from "./json.ts";
import type { DraftPointer } from "./types.ts";

/** The version a pointer has when it names no draft: the release itself, with nothing fetched. */
export const LOCAL_VERSION = "local";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;
/** The draft index's file in a draft folder. */
const DRAFT_INDEX = "index.json";

/** What a draft holds for one name: the whole block, or its deletion. */
export type DraftState = { operation: "set"; data: JsonObject } | { operation: "delete" };

/**
 * The domains a draft pointer's host may fall under, the defaults v7 shipped.
 * Deco operates every one of them, so the defaults add no SSRF surface. An
 * entry starting with a dot matches any host that ends with it, on a label
 * boundary (`evil-decocms.com` doesn't pass `.decocms.com`); any other entry
 * matches that exact host. The first entry that matches decides whether a
 * port and plain `http` are allowed.
 */
export const DEFAULT_DRAFT_HOSTS: readonly string[] = [
  "local.studio.decocms.com", // the Studio dev origin (https, with a port)
  "localhost",
  "127.0.0.1",
  ".localhost",
  ".decocms.com", // Studio, its preview deployments and delivery.decocms.com
];

/**
 * `createCMS`'s `preview.draftHosts`, trimmed and lowercased, or the defaults
 * when it's left out. Throws a `TypeError` on anything but a list of
 * non-empty strings.
 */
export function parseDraftHosts(preview: { draftHosts?: unknown } | undefined): readonly string[] {
  const domains = preview?.draftHosts;
  if (domains === undefined) return DEFAULT_DRAFT_HOSTS;
  if (
    !Array.isArray(domains) ||
    domains.some((domain) => typeof domain !== "string" || domain.trim() === "")
  ) {
    throw new TypeError("createCMS: `preview.draftHosts` must be a list of hosts");
  }
  return domains.map((domain: string) => domain.trim().toLowerCase());
}

/**
 * The origin a pointer's host is fetched from, or `null` when no draft host
 * admits it. Loopback domains (and `local.studio.decocms.com`) may
 * carry a port; a public domain may not, so a pointer can't aim the fetch at
 * an odd port. Loopback hosts are `http`; everything else is `https`.
 */
export function previewApiOrigin(
  authority: string,
  domains: readonly string[] = DEFAULT_DRAFT_HOSTS,
): string | null {
  const lower = authority.toLowerCase();
  const end = lower.startsWith("[") ? lower.indexOf("]") + 1 : -1;
  const host = end > 0 ? lower.slice(0, end) : lower.split(":")[0]!;
  const rest = end > 0 ? lower.slice(end) : lower.slice(host.length);
  const port = rest.startsWith(":") ? rest.slice(1) : undefined;
  if (!host) return null;
  const domain = domains.find((d) =>
    d.startsWith(".") ? host.length > d.length && host.endsWith(d) : host === d,
  );
  if (domain === undefined) return null;
  const insecure = isLoopbackDomain(domain);
  if (port !== undefined && !insecure && domain !== "local.studio.decocms.com") return null;
  return `${insecure ? "http" : "https"}://${host}${port === undefined ? "" : `:${port}`}`;
}

function isLoopbackDomain(domain: string): boolean {
  return (
    domain === "localhost" ||
    domain === "127.0.0.1" ||
    domain === "[::1]" ||
    domain.endsWith(".localhost")
  );
}

/** The file a block's draft lives in, inside the draft folder; `index` can't be the draft index. */
export function draftFileName(name: string): string {
  return name === "index" ? "%69ndex.json" : `${encodeURIComponent(name)}.json`;
}

/**
 * The draft folder's URL for a pointer (ending in `/`), from the origin its
 * host is admitted under. `null` when no draft host admits the host; throws
 * when the path isn't a draft folder's index.
 */
export function draftFolderUrl(
  pointer: DraftPointer,
  domains: readonly string[] = DEFAULT_DRAFT_HOSTS,
): string | null {
  const origin = previewApiOrigin(pointer.host, domains);
  if (origin === null) return null;
  const q = pointer.path.indexOf("?");
  const path = q === -1 ? pointer.path : pointer.path.slice(0, q);
  if (!path.endsWith(`/${DRAFT_INDEX}`)) {
    throw new Error("draft pointer: not a draft folder (the path must end in /index.json)");
  }
  return `${origin}${path.slice(0, -DRAFT_INDEX.length)}`;
}

/**
 * Reads a draft: its index, then every file it names, in one parallel wave.
 * Resolves with the names the draft sets or deletes. Rejects on a host no
 * draft host admits (without fetching), a path that isn't a draft folder, and
 * any failure but a missing file.
 */
export async function fetchDraft(
  pointer: DraftPointer,
  options: { domains?: readonly string[] } = {},
): Promise<Map<string, DraftState>> {
  const folder = draftFolderUrl(pointer, options.domains);
  if (folder === null) {
    throw new Error(
      `draft pointer names "${pointer.host}", which isn't under a draft host ` +
        "(createCMS({ preview: { draftHosts } })); nothing was fetched",
    );
  }
  const index = await getJson(`${folder}${DRAFT_INDEX}`, "draft index");
  if (index === undefined) throw new Error("draft index: HTTP 404");
  const names = draftIndexNames(index);
  const files = await Promise.all(
    names.map((name) =>
      getJson(`${folder}${encodeURIComponent(draftFileName(name))}`, `draft file "${name}"`),
    ),
  );
  const states = new Map<string, DraftState>();
  names.forEach((name, i) => {
    const state = parseDraftFile(files[i], name);
    if (state !== null) states.set(name, state);
  });
  return states;
}

/** `{ names: [...] }`: the strings, deduped, in their order. */
function draftIndexNames(body: unknown): string[] {
  if (!isPlainObject(body) || !Array.isArray(body.names)) {
    throw new Error("draft index: expected { names: [...] }");
  }
  return [...new Set(body.names.filter((name): name is string => typeof name === "string"))];
}

/** A draft file: what it holds, or `null` for a missing file or a `published` marker. */
export function parseDraftFile(body: unknown, name: string): DraftState | null {
  if (body === undefined) return null;
  const invalid = () => new Error(`draft file "${name}": unexpected format`);
  if (!isPlainObject(body)) throw invalid();
  switch (body.operation) {
    case "set":
      if (!isPlainObject(body.data)) throw invalid();
      return { operation: "set", data: body.data };
    case "delete":
      return { operation: "delete" };
    case "published":
      return null;
    default:
      throw invalid();
  }
}

/**
 * `url` with a fresh `r` query parameter: a cache key no shared cache has
 * seen, so the read always reaches storage (which ignores the query). Draft
 * folder URLs carry no query of their own (see {@link draftFolderUrl}).
 */
function uncachedUrl(url: string): string {
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${url}${url.includes("?") ? "&" : "?"}r=${nonce}`;
}

/** GETs a draft object, past any shared cache: its JSON, or `undefined` for a 404. */
async function getJson(objectUrl: string, label: string): Promise<unknown> {
  const url = uncachedUrl(objectUrl);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: timeoutSignal(TIMEOUT_MS),
  });
  // Some fetch polyfills (React Native, whatwg-fetch) ignore `redirect: "manual"`
  // and follow anyway: refuse a response that came from anywhere else.
  if (
    response.redirected ||
    (response.url && new URL(response.url).origin !== new URL(url).origin)
  ) {
    await response.body?.cancel();
    throw new Error(`${label}: the pointer's address redirected; nothing was read`);
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`${label}: HTTP ${response.status}`);
  }
  return readBoundedJson(response, label, MAX_BYTES);
}

/**
 * The draft over `base`: each `set` replaces (or adds) the entry, with its
 * `meta` from `blockMeta` over the overlaid names and its body held by this
 * content only; each `delete` removes the entry. Production is never mutated.
 * Its revision, `<base revision>~<view>`, is an opaque identity of the pair,
 * never a release's.
 */
export function overlayDraft(
  base: IndexedContent,
  states: ReadonlyMap<string, DraftState>,
  view: string,
): IndexedContent {
  const names = new Set(Object.keys(base.blocks));
  const bodies = new Map<string, unknown>();
  for (const [name, state] of states) {
    if (state.operation === "delete") names.delete(name);
    else {
      names.add(name);
      bodies.set(name, state.data);
    }
  }
  const blocks = Object.create(null) as BlockIndex;
  // A page's saved SEO block: the draft's own body, else one the base holds.
  const bodyOf = (name: string): unknown =>
    bodies.has(name) ? bodies.get(name) : states.has(name) ? undefined : base.held?.get(name);
  for (const name of names) {
    if (bodies.has(name)) {
      const meta = blockMeta(bodies.get(name), names, bodyOf);
      const entry: IndexEntry = { version: "" };
      if (Object.keys(meta).length > 0) entry.meta = meta;
      blocks[name] = entry;
    } else {
      blocks[name] = base.blocks[name] as IndexEntry;
    }
  }
  const baseHeld = base.held;
  const held: HeldBodies = {
    has: (name) => bodies.has(name) || (!states.has(name) && baseHeld?.has(name) === true),
    get: (name) =>
      bodies.has(name) ? bodies.get(name) : states.has(name) ? undefined : baseHeld?.get(name),
  };
  const content: IndexedContent = {
    revision: `${base.revision}~${view}`,
    sequence: base.sequence,
    metaVersion: base.metaVersion,
    blocks,
    held,
    draft: true,
  };
  if (base.aliases !== undefined) (content as { aliases?: unknown }).aliases = base.aliases;
  if (base.source !== undefined) (content as { source?: unknown }).source = base.source;
  return content;
}
