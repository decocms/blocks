/**
 * `@decocms/blocks/vite/hot`: the runtime half of the dev server's content
 * reload. The `decoContent()` Vite plugin (`@decocms/blocks/vite`) appends a
 * call to it to `.deco/blocks.gen.ts` in `vite dev`; a site never imports it.
 */
export { adoptContent } from "../cms.ts";
