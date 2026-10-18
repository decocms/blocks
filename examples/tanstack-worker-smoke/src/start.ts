// Server-function calls carry the page's CDN segment token, so the CDN can cache navigation data.
import { decoServerFnFetch } from "@decocms/tanstack/start";
import { createStart } from "@tanstack/react-start";

export const startInstance = createStart(() => ({ serverFns: { fetch: decoServerFnFetch } }));
