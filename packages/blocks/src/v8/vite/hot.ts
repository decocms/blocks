/**
 * `@decocms/blocks/vite/hot`: the runtime half of the dev server's content
 * reload. In `vite dev`, the `decoContent()` Vite plugin
 * (`@decocms/blocks/vite`) appends a call to it to each module that imports
 * `.deco/blocks.gen.ts`; a site never imports it.
 */
export { adoptContent } from "../cms.ts";
