import type { MigrationContext } from "../types";

/**
 * Server-only commerce + invoke registration.
 *
 * `commerce-loaders.ts` statically imports COMMERCE_LOADERS, which pulls in the
 * site's loader/action modules and the platform commerce loaders. If that graph
 * is reachable from the CLIENT entry (router.tsx -> setup.ts), Vite bundles all
 * of it — and any credential hardcoded in a site loader/action — into the
 * browser assets. So the registration lives here instead and is imported ONLY by
 * the worker entry (server), never by router.tsx.
 *
 * This is safe because both consumers run server-side:
 *   - CMS commerce-loader resolution (loadCmsPage server fn), via
 *     registerCommerceLoaders.
 *   - the /deco/invoke handler, via setInvokeLoaders(() => COMMERCE_LOADERS)
 *     -> getRegisteredLoaders() inside handleInvoke.
 *
 * Client components reach loaders/actions exclusively through the HTTP `invoke`
 * proxy (@decocms/blocks/sdk/invoke), which imports no modules.
 */
export function generateCommerceInit(_ctx: MigrationContext): string {
  return `/**
 * Server-only commerce + invoke registration.
 *
 * Imported ONLY by the worker entry (src/worker-entry.ts), never by
 * src/router.tsx. This keeps COMMERCE_LOADERS — and every site loader/action
 * module it imports — out of the client bundle, so no server-side credential
 * can leak into the browser assets. Both consumers run server-side:
 *   - CMS commerce-loader resolution (registerCommerceLoaders)
 *   - the /deco/invoke handler (setInvokeLoaders)
 * The client reaches loaders/actions only via the HTTP invoke proxy.
 */
import { registerCommerceLoaders } from "@decocms/blocks/cms";
import { setInvokeLoaders } from "@decocms/blocks-admin";

import { COMMERCE_LOADERS } from "./commerce-loaders";

registerCommerceLoaders(COMMERCE_LOADERS);
setInvokeLoaders(() => COMMERCE_LOADERS);
`;
}
