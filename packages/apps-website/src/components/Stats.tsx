/**
 * Moved to `@decocms/blocks/hooks`, and re-exported here so nothing that already imports
 * `@decocms/apps-website/components/Stats` breaks.
 *
 * It moved because `DecoRootLayout` mounts it now: `@decocms/tanstack` importing from an apps
 * package would add an edge to a dependency graph this repo keeps one-way on purpose, and the
 * component never needed to be here — it is a `<link>` and a `<script>` pointing at our own
 * collector, not a vendor integration like `OneDollarStats`.
 *
 * Sites do not need to import it at all any more. Set `DECO_ANALYTICS_ENABLED=true`.
 */
export {
	Stats as default,
	STATS_DEFAULT_ORIGIN as DEFAULT_ORIGIN,
	type StatsProps as Props,
} from "@decocms/blocks/hooks";
