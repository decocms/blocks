import { createCMS } from "@decocms/blocks";
import { contentClient } from "@decocms/tanstack/server";
import blocks from "../.deco";
import content from "../.deco/blocks.gen";

// Serves the content module (no site: a hosted site reads its content from the delivery CDN at
// runtime and previews where Studio's release metadata says); it lists its local host here.
export const cms = createCMS({
  blocks,
  content,
  preview: { hosts: ["127.0.0.1"] },
});

// The client for this request: cms.client({ visitor, version }) with the visitor and the
// version (a Studio link's draft or old release, else the current one) the worker read.
export const client = (request: Request) => contentClient(cms, request);
