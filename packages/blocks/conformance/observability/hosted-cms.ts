// hosted-telemetry.mdx › Turn it on, verbatim.
import { createCMS } from "@decocms/blocks";
import blocks from "./.deco";

// Your app reads its own environment and passes the values; the SDK reads none.
export const cms = createCMS({
  blocks,
  site: process.env.DECO_SITE,          // content from the CDN, releases and drafts
  token: process.env.DECO_SITE_TOKEN,   // hosted telemetry (server-only secret)
});
