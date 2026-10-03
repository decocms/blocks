import "server-only";
import { cms } from "./cms";

// The client for this request. Every page gets its client here, so this is the one place to change
// if requests ever need different content.
export async function client() {
  return cms.forRelease();
}
