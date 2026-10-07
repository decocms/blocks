/**
 * Draft changes (see /next/content-delivery#draft-previews): what a draft
 * pointer's address answers, and how the CMS layers it over production.
 *
 * - The pointer's host must fall under one of the draft hosts (the same rule
 *   as v7's preview API domains): by default `*.decocms.com` (Studio, the
 *   delivery CDN, `local.studio.decocms.com`) and the loopback hosts;
 *   `createCMS({ preview: { draftHosts } })` replaces the list. Any other host
 *   is refused before anything is fetched.
 * - `GET <scheme>://<host><path>?v=<version>`: the scheme comes from the
 *   domain that admitted the host, never from the pointer: plain `http` only
 *   for loopback hosts. The pointer's `__variant` parameters are already gone (the parser
 *   lifts them out), no cookies or credentials are sent, and redirects aren't
 *   followed (a response that was redirected anyway is refused).
 * - Every read revalidates: with a body this process already holds, it sends
 *   `If-None-Match` with that body's ETag, and a `304` reuses the body. Only
 *   a 200 or that 304 is accepted, within 10 s; a 200 is up to 16 MiB, shaped
 *   exactly `{ set: { <name>: <block JSON> }, delete: [<name>…] }` with `set`
 *   and `delete` disjoint.
 */
import { readBoundedJson, timeoutSignal } from "./boundedJson.ts";
import { isPlainObject } from "./json.ts";
import type { DraftPointer, Snapshot } from "./types.ts";

/** The version a pointer has when it names no draft: `deco serve`'s working tree. */
export const LOCAL_VERSION = "local";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;

/** What a draft changed compared with production: whole blocks, and deletions. */
export interface DraftChanges {
  set: Record<string, unknown>;
  delete: string[];
}

/** A draft read: new changes (and their ETag), or `304`, the held body is current. */
export type DraftRead =
  | { status: 200; changes: DraftChanges; etag: string | null }
  | { status: 304 };

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

/**
 * The URL the SDK fetches for a pointer: the origin its host is admitted
 * under, the version as `v`. `null` when no draft host admits the host.
 */
export function draftChangesUrl(
  pointer: DraftPointer,
  domains: readonly string[] = DEFAULT_DRAFT_HOSTS,
): string | null {
  const origin = previewApiOrigin(pointer.host, domains);
  if (origin === null) return null;
  const separator = pointer.path.includes("?") ? "&" : "?";
  return `${origin}${pointer.path}${separator}v=${encodeURIComponent(pointer.version)}`;
}

/**
 * Reads a draft's changes, revalidating `etag` (the ETag of the body the
 * caller holds) when given. Rejects on a host no draft host admits
 * (without fetching), on a `304` to a request that sent no ETag, and on any
 * other failure.
 */
export async function fetchDraftChanges(
  pointer: DraftPointer,
  options: { domains?: readonly string[]; etag?: string | null } = {},
): Promise<DraftRead> {
  const url = draftChangesUrl(pointer, options.domains);
  if (url === null) {
    throw new Error(
      `draft pointer names "${pointer.host}", which isn't under a draft host ` +
        "(createCMS({ preview: { draftHosts } })); nothing was fetched",
    );
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.etag) headers["if-none-match"] = options.etag;
  const response = await fetch(url, {
    headers,
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
    throw new Error("draft changes: the pointer's address redirected; nothing was read");
  }
  if (response.status === 304 && options.etag) {
    await response.body?.cancel();
    return { status: 304 };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`draft changes: HTTP ${response.status}`);
  }
  const etag = response.headers.get("etag");
  const changes = parseDraftChanges(await readBoundedJson(response, "draft changes", MAX_BYTES));
  return { status: 200, changes, etag };
}

/** Validates a draft changes response; throws on any unexpected shape. */
export function parseDraftChanges(body: unknown): DraftChanges {
  const invalid = (why: string) => new Error(`draft changes: ${why}`);
  if (!isPlainObject(body)) throw invalid("expected an object");
  if (Object.keys(body).some((key) => key !== "set" && key !== "delete")) {
    throw invalid("unexpected field");
  }
  const { set, delete: deleted } = body;
  if (!isPlainObject(set)) throw invalid("set must be an object");
  if (!Array.isArray(deleted) || deleted.some((name) => typeof name !== "string")) {
    throw invalid("delete must be a list of names");
  }
  if (new Set(deleted).size !== deleted.length) throw invalid("delete repeats a name");
  if (deleted.some((name) => Object.hasOwn(set, name))) throw invalid("set and delete overlap");
  return body as unknown as DraftChanges;
}

/**
 * The draft as a snapshot: production's entries, with the changed ones
 * replaced whole and the deleted ones gone. A shallow copy: every unchanged
 * entry is production's own object, and production is never mutated. Its
 * revision, `<base revision>~<view>`, is an opaque identity of the pair,
 * never a release's; `view` names the draft body (its ETag), so each save
 * re-keys what's cached by revision.
 */
export function layerDraft(base: Snapshot, changes: DraftChanges, view: string): Snapshot {
  const blocks: Record<string, unknown> = { ...base.blocks };
  for (const name of changes.delete) delete blocks[name];
  for (const [name, entry] of Object.entries(changes.set)) {
    // defineProperty, so an entry named "__proto__" stays an entry.
    Object.defineProperty(blocks, name, {
      value: entry,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const layered: Snapshot = { revision: `${base.revision}~${view}`, blocks };
  if (base.aliases !== undefined) layered.aliases = base.aliases;
  return layered;
}
