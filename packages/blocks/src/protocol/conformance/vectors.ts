/**
 * Golden vectors for `blockMeta` and `indexEntry` (see
 * `@decocms/blocks/protocol`): every implementation that writes or reads a
 * revision index (the SDK, the CLI, Studio's publish) checks it computes these
 * exact entries. The JSON file is shared byte for byte with Studio's vendored
 * copy.
 *
 * ```ts
 * import { blockMetaVectors } from "@decocms/blocks/protocol/conformance";
 * for (const c of blockMetaVectors.cases) {
 *   expect(blockMeta(c.body, blockMetaVectors.names)).toEqual(c.meta);
 * }
 * ```
 */
import type { BlockMeta, IndexEntry } from "../../v8/blockMeta.ts";
import vectors from "./blockMetaVectors.json" with { type: "json" };

export interface BlockMetaVector {
  /** The block's name in the index. */
  name: string;
  body: unknown;
  /** `blockVersion(body)`. */
  version: string;
  /** `blockMeta(body, names)`. */
  meta: BlockMeta;
  /** `indexEntry(name, body, names)`. */
  entry: IndexEntry;
}

export interface BlockMetaVectors {
  /** The block names of the index the cases are computed for. */
  names: readonly string[];
  cases: readonly BlockMetaVector[];
}

export const blockMetaVectors: BlockMetaVectors = vectors as BlockMetaVectors;
