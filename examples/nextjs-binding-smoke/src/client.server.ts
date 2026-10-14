import "server-only";
import { contentClient } from "@decocms/nextjs/server";
import { cms } from "./cms";

// The client for this request: the draft a page bound (bindDraft), or the release.
export async function client() {
  return contentClient(cms);
}
