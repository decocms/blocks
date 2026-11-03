/**
 * Moved to `@decocms/blocks/hooks`, and re-exported here so nothing that already imports
 * `@decocms/apps-website/components/Stats` breaks.
 *
 * It moved because `DecoRootLayout` mounts it now: `@decocms/tanstack` importing from an apps
 * package would add an edge to a dependency graph this repo keeps one-way on purpose, and the
 * component never needed to be here — it is a `<link>` and a `<script>` pointing at our own
 * collector, not a vendor integration like `OneDollarStats`.
 *
 * TanStack sites on `DecoRootLayout` do not need to import it any more: set
 * `DECO_ANALYTICS_SITE_KEY`, `DECO_ANALYTICS_FIRST_PARTY=true` or `DECO_ANALYTICS_ORIGIN`. The
 * Next.js layout does not mount it.
 */
export {
	Stats as default,
	STATS_DEFAULT_ORIGIN as DEFAULT_ORIGIN,
	type StatsProps as Props,
} from "@decocms/blocks/hooks";
