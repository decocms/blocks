/**
 * @decocms/start/node — Node-only helpers.
 *
 * These helpers depend on `node:fs`, `node:path`, etc. and are not safe
 * to import into client bundles. Use from server entry points only.
 */
export { loadAllDecofileBlocks } from "./loadAllDecofileBlocks";
