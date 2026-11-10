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

/** The type of the site's one redirects block (canonically saved as `Redirects`). */
export const REDIRECTS_TYPE = "redirects";

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

/** The `telemetry` section's built-in defaults; code's `telemetry.defaults` replace the two rates. */
export const TELEMETRY_DEFAULTS: Readonly<Required<Telemetry>> = Object.freeze({
  enabled: true,
  metrics: true,
  errorSampleRate: 0.05,
  traceSampleRate: 0,
});

/** The well-known saved block that holds the CMS settings, and its built-in type. */
export const SETTINGS_BLOCK = "CMS";
export const SETTINGS_TYPE = "cms-settings";

/** The two sample rates a site falls back to when content saves none. */
export type SampleRates = { errorSampleRate: number; traceSampleRate: number };

/**
 * The `telemetry` section with its defaults filled in: a rate content saved
 * wins (held to 0–1), else `defaults` (code's `telemetry.defaults`, else
 * the built-in ones).
 */
export function telemetrySection(
  section: unknown,
  defaults: SampleRates = TELEMETRY_DEFAULTS,
): Required<Telemetry> {
  const t = isRecord(section) ? section : {};
  return {
    enabled: typeof t.enabled === "boolean" ? t.enabled : TELEMETRY_DEFAULTS.enabled,
    metrics: typeof t.metrics === "boolean" ? t.metrics : TELEMETRY_DEFAULTS.metrics,
    errorSampleRate: rate(t.errorSampleRate, defaults.errorSampleRate),
    traceSampleRate: rate(t.traceSampleRate, defaults.traceSampleRate),
  };
}

/**
 * The `telemetry` section as the `cms-settings` block returns it: switches
 * filled in, sample rates only where content saved one. The block can't see
 * code's `telemetry.defaults`; `cms.settings()` fills the rates from them.
 */
function savedTelemetry(section: unknown): Telemetry & { enabled: boolean; metrics: boolean } {
  const t = isRecord(section) ? section : {};
  const { enabled, metrics } = telemetrySection(t);
  return {
    enabled,
    metrics,
    ...(typeof t.errorSampleRate === "number" && Number.isFinite(t.errorSampleRate)
      ? { errorSampleRate: rate(t.errorSampleRate, 0) }
      : {}),
    ...(typeof t.traceSampleRate === "number" && Number.isFinite(t.traceSampleRate)
      ? { traceSampleRate: rate(t.traceSampleRate, 0) }
      : {}),
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
 * input with the telemetry switches and the analytics defaults filled in; a
 * sample rate content didn't save stays out (`cms.settings()` fills it from
 * code's `telemetry.defaults`). Preview hosts aren't here: Studio writes them
 * into the release metadata.
 */
export const cmsSettings = (
  props: CMSSettings = {},
): CMSSettings & {
  telemetry: Telemetry & { enabled: boolean; metrics: boolean };
  analytics: Required<Analytics>;
} => ({
  ...props,
  telemetry: savedTelemetry(props.telemetry),
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
