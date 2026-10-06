/**
 * Draft changes (see /next/content-delivery#draft-previews): what a draft
 * pointer's address answers, and how the CMS layers it over production.
 *
 * - The pointer's host must be one of `preview.sources` (code only, default
 *   `studio.decocms.com`); any other host is refused before anything is fetched.
 * - `GET https://<host><path>&v=<version>`: plain `http` only for loopback
 *   hosts. The pointer's `__variant` parameters are already gone (the parser
 *   lifts them out), no cookies or credentials are sent, and redirects aren't
 *   followed (a response that was redirected anyway is refused).
 * - Only a 200 is accepted, within 10 s and up to 16 MiB, shaped exactly
 *   `{ format: 1, set: { <name>: <block JSON> }, delete: [<name>…] }` with
 *   `set` and `delete` disjoint.
 */
import { readBoundedJson, timeoutSignal } from "./boundedJson.ts";
import { allowsHost, type HostPattern } from "./hosts.ts";
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

/** The URL the SDK fetches for a pointer: the scheme from its host, the version as `v`. */
export function draftChangesUrl(pointer: DraftPointer): string {
  const scheme = isLoopback(pointer.host) ? "http" : "https";
  const separator = pointer.path.includes("?") ? "&" : "?";
  return `${scheme}://${pointer.host}${pointer.path}${separator}v=${encodeURIComponent(pointer.version)}`;
}

/** Fetches a draft's changes; rejects on a host outside `sources` (without fetching) or on any failure. */
export async function fetchDraftChanges(
  pointer: DraftPointer,
  sources: readonly HostPattern[],
): Promise<DraftChanges> {
  const url = draftChangesUrl(pointer);
  if (!allowsHost(sources, url)) {
    throw new Error(
      `draft pointer names "${pointer.host}", which isn't in preview.sources; nothing was fetched`,
    );
  }
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: timeoutSignal(TIMEOUT_MS),
  });
  // Some fetch polyfills (React Native, whatwg-fetch) ignore `redirect: "manual"`
  // and follow anyway: refuse a response that came from anywhere else.
  if (response.redirected || (response.url && !allowsHost(sources, response.url))) {
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

function isLoopback(authority: string): boolean {
  const host = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : authority.split(":")[0]!;
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]"
  );
}
