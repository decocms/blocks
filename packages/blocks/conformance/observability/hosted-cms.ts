// hosted-telemetry.mdx › Turn it on, verbatim.
import { createCMS } from "@decocms/blocks";
import blocks from "./.deco";
import content from "./.deco/blocks.gen";

// Your app reads its own environment and passes the values; the SDK reads none.
export const cms = createCMS({
  blocks,
  content,
  site: process.env.DECO_SITE,          // hosted releases
  token: process.env.DECO_SITE_TOKEN,   // hosted telemetry (server-only secret)
});
