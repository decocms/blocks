/**
 * Moved to `@decocms/blocks/hooks`, and re-exported here so nothing that already imports
 * `@decocms/apps-website/components/OneDollarStats` breaks.
 *
 * It moved so `DecoRootLayout` can mount it (behind `ONEDOLLAR_AUTOMOUNT`) without
 * `@decocms/tanstack` importing from an apps package — the same reason `Stats` moved.
 */
export {
  ONEDOLLAR_DEFAULT_COLLECTOR as DEFAULT_COLLECTOR_ADDRESS,
  ONEDOLLAR_DEFAULT_SCRIPT_URL as DEFAULT_ANALYTICS_SCRIPT_URL,
  OneDollarStats as default,
  type OneDollarStatsProps as Props,
  readFlagsFromCookie,
} from "@decocms/blocks/hooks";
