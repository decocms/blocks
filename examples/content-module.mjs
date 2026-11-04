// The example apps have no `site`: they serve the content in their own
// .deco/blocks, bundled as .deco/blocks.gen.ts. There is no `deco content`
// command (a site with `site` set gets its content at runtime), so their
// predev/prebuild scripts write the module with content() from the CLI's API.
// Run from an example's folder: node ../content-module.mjs
import { content } from "@decocms/blocks/cli";

process.exitCode = await content();
