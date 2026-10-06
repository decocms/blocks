/**
 * Draft changes (see /next/content-delivery#draft-previews): what a draft
 * pointer's address answers, and how the CMS layers it over production.
 *
 * - The pointer's host must fall under one of the preview API domains (the
 *   same rule as v7): by default `*.decocms.com` (Studio, its PR previews,
 *   `local.studio.decocms.com`) and the loopback hosts; `DECO_PREVIEW_API_DOMAINS`
 *   replaces the list. Any other host is refused before anything is fetched.
 * - `GET <scheme>://<host><path>&v=<version>`: the scheme comes from the
 *   domain that admitted the host, never from the pointer: plain `http` only
 *   for loopback hosts. The pointer's `__variant` parameters are already gone (the parser
 *   lifts them out), no cookies or credentials are sent, and redirects aren't
 *   followed (a response that was redirected anyway is refused).
 * - Only a 200 is accepted, within 10 s and up to 16 MiB, shaped exactly
 *   `{ format: 1, set: { <name>: <block JSON> }, delete: [<name>…] }` with
 *   `set` and `delete` disjoint.
 */
import { readBoundedJson, timeoutSignal } from "./boundedJson.ts";
import { readEnv } from "./identity.ts";
import { isPlainObject } from "./json.ts";
import type { DraftPointer, Snapshot } from "./types.ts";

/** The version a pointer has when it names no draft: `deco serve`'s working tree. */
export const LOCAL_VERSION = "local";

const FORMAT = 1;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;

/** What a draft changed compared with production: whole blocks, and deletions. */
export interface DraftChanges {
  format: typeof FORMAT;
  set: Record<string, unknown>;
  delete: string[];
}

/**
 * The domains a draft pointer's host may fall under, the defaults v7 shipped.
 * Deco operates every one of them, so the defaults add no SSRF surface. An
 * entry starting with a dot matches any host that ends with it, on a label
 * boundary (`evil-decocms.com` doesn't pass `.decocms.com`); any other entry
 * matches that exact host. The first entry that matches decides whether a
 * port and plain `http` are allowed.
 */
export const DEFAULT_PREVIEW_API_DOMAINS: readonly string[] = [
  "local.studio.decocms.com", // the Studio dev origin (https, with a port)
  "localhost",
  "127.0.0.1",
  "[::1]",
  ".localhost",
  ".decocms.com", // Studio and its preview deployments
];

/** `DECO_PREVIEW_API_DOMAINS` (a comma list) when set, else the defaults. */
function previewApiDomains(): readonly string[] {
  const configured = (readEnv("DECO_PREVIEW_API_DOMAINS") ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_PREVIEW_API_DOMAINS;
}

/**
 * The origin a pointer's host is fetched from, or `null` when no preview API
 * domain admits it. Loopback domains (and `local.studio.decocms.com`) may
 * carry a port; a public domain may not, so a pointer can't aim the fetch at
 * an odd port. Loopback hosts are `http`; everything else is `https`.
 */
export function previewApiOrigin(authority: string): string | null {
  const lower = authority.toLowerCase();
  const end = lower.startsWith("[") ? lower.indexOf("]") + 1 : -1;
  const host = end > 0 ? lower.slice(0, end) : lower.split(":")[0]!;
  const rest = end > 0 ? lower.slice(end) : lower.slice(host.length);
  const port = rest.startsWith(":") ? rest.slice(1) : undefined;
  if (!host) return null;
  const domain = previewApiDomains().find((d) =>
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
 * under, the version as `v`. `null` when no preview API domain admits the host.
 */
export function draftChangesUrl(pointer: DraftPointer): string | null {
  const origin = previewApiOrigin(pointer.host);
  if (origin === null) return null;
  const separator = pointer.path.includes("?") ? "&" : "?";
  return `${origin}${pointer.path}${separator}v=${encodeURIComponent(pointer.version)}`;
}

/** Fetches a draft's changes; rejects on a host no preview API domain admits (without fetching) or on any failure. */
export async function fetchDraftChanges(pointer: DraftPointer): Promise<DraftChanges> {
  const url = draftChangesUrl(pointer);
  if (url === null) {
    throw new Error(
      `draft pointer names "${pointer.host}", which isn't under a preview API domain ` +
        "(DECO_PREVIEW_API_DOMAINS); nothing was fetched",
    );
  }
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
    throw new Error("draft changes: the pointer's address redirected; nothing was read");
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`draft changes: HTTP ${response.status}`);
  }
  return parseDraftChanges(await readBoundedJson(response, "draft changes", MAX_BYTES));
}

/** Validates a draft changes response; throws on an unknown format or any unexpected shape. */
export function parseDraftChanges(body: unknown): DraftChanges {
  const invalid = (why: string) => new Error(`draft changes: ${why}`);
  if (!isPlainObject(body) || body.format !== FORMAT) throw invalid("unknown format");
  if (Object.keys(body).some((key) => key !== "format" && key !== "set" && key !== "delete")) {
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
 * revision is an opaque identity of the pair, never a release's.
 */
export function layerDraft(base: Snapshot, changes: DraftChanges, version: string): Snapshot {
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
  const view: Snapshot = { revision: `${base.revision}~${version}`, blocks };
  if (base.aliases !== undefined) view.aliases = base.aliases;
  return view;
}
