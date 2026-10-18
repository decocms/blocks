// The Worker: TanStack Start behind the Deco worker (edge cache, drafts, Studio framing, redirects).
import { createDecoWorker } from "@decocms/tanstack/worker";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { cms } from "./cms";

export default createDecoWorker({
  serverEntry: createServerEntry({ fetch: handler.fetch }),
  cms,
  site: "tanstack-worker-smoke",
  buildHash: __BUILD_HASH__,
  dev: import.meta.env.DEV,
  purgeToken: (env: { PURGE_TOKEN?: string }) => env.PURGE_TOKEN,
});
