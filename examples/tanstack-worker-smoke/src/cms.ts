import { createCMS } from "@decocms/blocks";
import { contentClient } from "@decocms/tanstack/server";
import blocks from "../.deco";
import content from "../.deco/blocks.gen";

// Serves the content module: the content of the commit this build was made from.
export const cms = createCMS({ blocks, content, dev: import.meta.env.DEV });

// The client for this request: the draft the worker accepted, or the release.
export const client = (request: Request) => contentClient(cms, request);
