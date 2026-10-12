/**
 * What `@decocms/blocks/protocol/storage/fs` resolves to outside Node (the
 * package's `default` export condition): the same API, failing on use. The
 * filesystem storage needs `node:fs`; on Workers or in a browser, implement
 * `ContentStorage` over the storage you have instead.
 */
import type { createFsStorage as nodeCreateFsStorage } from "./index.ts";

export type { FsStorage, FsStorageOptions } from "./index.ts";

export const createFsStorage: typeof nodeCreateFsStorage = () => {
  throw new Error(
    "@decocms/blocks/protocol/storage/fs needs Node (node:fs); it isn't available in this runtime",
  );
};
