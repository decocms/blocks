import "server-only";
import { contentClient } from "@decocms/nextjs/server";
import { cms } from "./cms";

// The client for this request: cms.client({ version, experiments, campaigns }) with the version
// (a Studio link's draft or old release, else the current one) and the tests and campaigns the
// proxy decided, which bindDraft bound.
export async function client() {
  return contentClient(cms);
}
