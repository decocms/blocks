import { createCMS } from "@decocms/blocks";
import { cmsConfig } from "./cms.config";

// The proxy's handle: no block map, so no section reaches the proxy bundle.
export const proxyCms = createCMS({ blocks: {}, ...cmsConfig });
