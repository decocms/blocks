import { createCMS } from "@decocms/blocks";
import blocks from "../.deco";
import { cmsConfig } from "./cms.config";

export const cms = createCMS({ blocks, ...cmsConfig });
