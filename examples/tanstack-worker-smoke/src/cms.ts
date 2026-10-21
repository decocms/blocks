import { createCMS } from "@decocms/blocks";
import { contentClient } from "@decocms/tanstack/server";
import blocks from "../.deco";
import content from "../.deco/blocks.gen";

// Serves the content module: the content of the commit this build was made from.
export const cms = createCMS({ blocks, content, dev: import.meta.env.DEV });

// The client for this request: cms.client({ visitor, version }) with the visitor and the
// version (a Studio link's draft or old release, else the current one) the worker read.
export const client = (request: Request) => contentClient(cms, request);
