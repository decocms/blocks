import { isNextDev } from "@decocms/nextjs/proxy";
import content from "../.deco/blocks.gen";

// Everything createCMS takes except the block map, shared by the app's handle (./cms.ts) and
// the proxy's (./cms.proxy.ts): the same options give one instance per process.
export const cmsConfig = { content, dev: isNextDev(process.env.NODE_ENV) };

// Where drafts preview: only the hosts Deco runs the site on (an empty list replaces the CMS
// block's), the same in the proxy and the pages.
export const preview = { site: "binding-smoke", previewHosts: [] as string[] };
