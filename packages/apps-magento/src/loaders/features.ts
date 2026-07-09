/**
 * Magento feature flags — returns the `features` block from the resolved
 * Magento config. Sites read this to gate optional client-side behavior
 * (cart on-load update, wishlist visibility, on-visibility-change update,
 * etc.) without re-deploying.
 *
 * In the legacy deco-cx/apps shape this lived as a 3-arg loader
 * `(_props, _req, ctx) => ctx.features`. The TanStack/Node port uses
 * the module-global config set by `configureMagento(...)` instead of a
 * per-request ctx, which matches the rest of @decocms/apps.
 */
import { getMagentoConfig, type MagentoFeatures } from "../client";

export default function features(): MagentoFeatures {
	return getMagentoConfig().features ?? {};
}
