import type { Analytics, CMSSettings, LegacyRedirect, Redirect, Telemetry } from "../types.ts";

/** The hosted Deco CMS collector: where page views go when `collector` is left out. */
export const HOSTED_ANALYTICS_COLLECTOR = "https://d.lilstts.com/events";

/** Where the Deco Analytics tag loads from unless the site opts into first-party. */
export const DECO_ANALYTICS_ORIGIN = "https://analytics.decocdn.com";

/** The Deco Analytics tag's path, on that origin or on a first-party site's own host. */
export const DECO_ANALYTICS_SCRIPT = "/_dq/a.js";

/**
 * `page`: its inputs are already resolved (`seo` and every block in
 * `sections`), so the page is its input.
 */
export const page = <P>(props: P): P => props;

/**
 * `redirect`: returns its arguments as saved. Still a built-in, so a v7 rule
 * block resolves, but no longer routed: `client.redirects()` reads only the
 * redirects block (`deco check` warns on every `redirect` block).
 */
export const redirect = (props: Redirect): Redirect => props;

/** The type of the site's one redirects block, and its canonical saved name. */
export const REDIRECTS_TYPE = "redirects";
export const REDIRECTS_BLOCK = "Redirects";

/**
 * `redirects`: the site's whole list of rules, one block (routing needs every
 * rule, so it is one cached fetch). Each rule has either shape `matchRoute`
 * reads: the flat `{ from, to, permanent?, status?, discardQueryParameters? }`
 * or v7's nested `{ redirect: { from, to, type? } }`; anything that isn't an
 * object is left out.
 */
export const redirects = (props: {
  redirects?: Array<Redirect | LegacyRedirect>;
}): Array<Redirect | LegacyRedirect> =>
  Array.isArray(props?.redirects)
    ? props.redirects.filter(
        (rule): rule is Redirect | LegacyRedirect =>
          typeof rule === "object" && rule !== null && !Array.isArray(rule),
      )
    : [];

/** The `telemetry` section's defaults (sample rates before code's caps). */
export const TELEMETRY_DEFAULTS: Readonly<Required<Telemetry>> = Object.freeze({
  enabled: true,
  metrics: true,
  errorSampleRate: 0.05,
  traceSampleRate: 0,
});

/** The well-known saved block that holds the CMS settings, and its built-in type. */
export const SETTINGS_BLOCK = "CMS";
export const SETTINGS_TYPE = "cms-settings";

/** The `telemetry` section with its defaults filled in; rates as saved, before any cap. */
export function telemetrySection(section: unknown): Required<Telemetry> {
  const t = isRecord(section) ? section : {};
  return {
    enabled: typeof t.enabled === "boolean" ? t.enabled : TELEMETRY_DEFAULTS.enabled,
    metrics: typeof t.metrics === "boolean" ? t.metrics : TELEMETRY_DEFAULTS.metrics,
    errorSampleRate: rate(t.errorSampleRate, TELEMETRY_DEFAULTS.errorSampleRate),
    traceSampleRate: rate(t.traceSampleRate, TELEMETRY_DEFAULTS.traceSampleRate),
  };
}

/** The `analytics` section with its defaults filled in. */
export function analyticsSection(section: unknown): Required<Analytics> {
  const a = isRecord(section) ? section : {};
  return {
    collector:
      typeof a.collector === "string" && a.collector !== ""
        ? a.collector
        : HOSTED_ANALYTICS_COLLECTOR,
    enabled: typeof a.enabled === "boolean" ? a.enabled : true,
    decoAnalyticsKey: typeof a.decoAnalyticsKey === "string" ? a.decoAnalyticsKey : "",
    decoAnalyticsFirstParty: a.decoAnalyticsFirstParty === true,
  };
}

/**
 * `cms-settings`: the type of the well-known saved block `CMS`. Returns its
 * input with the telemetry and analytics defaults filled in. Preview hosts
 * aren't here: Studio writes them into the release metadata.
 */
export const cmsSettings = (
  props: CMSSettings = {},
): CMSSettings & { telemetry: Required<Telemetry>; analytics: Required<Analytics> } => ({
  ...props,
  telemetry: telemetrySection(props.telemetry),
  analytics: analyticsSection(props.analytics),
});

/** A sample rate between 0 and 1, or `fallback` when it isn't a number. */
export function rate(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
