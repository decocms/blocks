// hosted-telemetry.mdx › Turn it on, verbatim.
import { createCMS } from "@decocms/blocks";
import blocks from "./.deco";
import content from "./.deco/blocks.gen";

const { DECO_SITE: site, DECO_SITE_TOKEN: token } = process.env;

export const cms = createCMS({
  blocks,
  content,
  site,                                               // loads releases and drafts
  token,
  telemetry: site && token ? { site, token } : false, // telemetry is separate: site/token above only load releases
});
