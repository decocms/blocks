/**
 * `@decocms/blocks/protocol/server`: the content protocol's server core.
 *
 * `createContentHandler(storage)` serves the four methods over any
 * `ContentStorage`. Web-standard APIs only, so it runs on Node, Bun, Workers
 * and Deno. (`deco serve`'s asset uploads use `./assets`, which isn't public.)
 */

export type { AuthOptions, AuthorizeResult } from "./auth.ts";
export type { ContentHandlerOptions } from "./core.ts";
export { type ContentHandler, createContentHandler } from "./handler.ts";
