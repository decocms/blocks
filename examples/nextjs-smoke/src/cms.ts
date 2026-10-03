import { createCMS } from "@decocms/blocks";
import blocks from "../.deco";
import content from "../.deco/blocks.gen";

// Serves the content module: the content of the commit this build was made from.
export const cms = createCMS({ blocks, content });
