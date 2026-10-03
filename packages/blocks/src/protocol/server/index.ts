/**
 * `@decocms/blocks/protocol/server`: the content protocol's server core.
 *
 * `createContentHandler(storage)` serves the four methods over any
 * `ContentStorage`; `createAssetHandler(storage)` serves `PUT /assets/<name>`
 * uploads. Web-standard APIs only, so both run on Node, Bun, Workers and Deno.
 */

export { isAcceptedAssetType, sanitizeAssetName, suffixedAssetName } from "../assets";
export { type AssetHandler, createAssetHandler } from "./assets";
export type { AuthOptions, AuthorizeResult } from "./auth";
export type { ContentHandlerOptions } from "./core";
export { type ContentHandler, createContentHandler } from "./handler";
