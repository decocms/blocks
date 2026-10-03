import { createCMS } from "@decocms/blocks";
import blocks from "../.deco";
import content from "../.deco/blocks.gen";

// Serves the content module: the content of the commit this build was made from.
export const cms = createCMS({ blocks, content });

// The client for this request. Every page gets its client here, so this is the one place to change
// if requests ever need different content.
export const client = (_request: Request) => cms.forRelease();
