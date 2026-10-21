import "server-only";
import { contentClient } from "@decocms/nextjs/server";
import { cms } from "./cms";

// The client for this request: cms.client({ visitor, version }) with the visitor and the
// version (a Studio link's draft or old release, else the current one) bindDraft bound.
export async function client() {
  return contentClient(cms);
}
