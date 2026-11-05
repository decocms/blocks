/**
 * The internal interface between the CMS and hosted releases
 * (`remoteLoader` with `site`): the current and previous index, the block
 * store, release checks, revisions by id and the preview hosts. Not exported
 * from the package.
 */
import type { BlockStore } from "./blockStore.ts";
import type { IndexedContent } from "./contentIndex.ts";

/** `Symbol.for`, so a second copy of this module recognises the source. */
export const HOSTED: unique symbol = Symbol.for("decocms.blocks.hostedSource");

/**
 * What the current release says about where it may be previewed (PO 2026-10-22):
 * - a list: the hosts Studio wrote (`previewHosts`), enforced;
 * - `"every"`: a remote site with no list published, so every host: no
 *   `latest.json` yet (a 404), or one without `previewHosts` (published
 *   before Studio wrote the list; its next publish writes one);
 * - `"local"`: content with no remote site (no release metadata at all):
 *   `createCMS`'s `preview.hosts` when set, else every host;
 * - `"unknown"`: the metadata couldn't be read (a network error, a 5xx, a
 *   malformed `latest.json`). That isn't "missing": previews stay closed.
 */
export type ReleasePreviewHosts = readonly string[] | "every" | "local" | "unknown";

export interface HostedSource {
  readonly [HOSTED]: true;
  /** The `interval` the loader was created with; `createCMS` reads it. */
  readonly interval: number | undefined;
  /** Bodies by hash, shared by every request of the isolate. */
  readonly blocks: BlockStore;
  /**
   * The current index: the one held, or the first load (shared by concurrent
   * callers; a failure isn't kept and rejects with a `ContentUnavailableError`).
   */
  current(): Promise<IndexedContent>;
  /** The current index from memory, `undefined` before the first load. */
  peek(): IndexedContent | undefined;
  /** The index that was current before the last adoption, if any. */
  previous(): IndexedContent | undefined;
  /**
   * Reads `latest.json` again (with `If-None-Match` on the held ETag) and adopts
   * it when its `sequence` is higher. Before the first load, it is that load.
   */
  poll(): Promise<{ updated: boolean }>;
  /** A published revision's index by id (`revisions/<id>/index.json`), kept a few at a time. */
  revision(id: string): Promise<IndexedContent>;
  /** The preview hosts (see `ReleasePreviewHosts`); `peek` never reads the network. */
  previewHosts(peek: boolean): Promise<ReleasePreviewHosts>;
}

export function isHostedSource(value: unknown): value is HostedSource {
  return (
    typeof value === "object" && value !== null && (value as Partial<HostedSource>)[HOSTED] === true
  );
}

/**
 * A release's `previewHosts` as Studio wrote them: the strings of a list;
 * `undefined` when the field is absent (no list written); an empty list (no
 * host) for a field that isn't a list, so a malformed one never opens previews.
 */
export function previewHostsOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.filter((host): host is string => typeof host === "string");
}
