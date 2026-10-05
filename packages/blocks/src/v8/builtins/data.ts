import type { Analytics, CMSSettings, Redirect, Telemetry } from "../types.ts";

/** The hosted Deco CMS collector: where page views go when `collector` is left out. */
export const HOSTED_ANALYTICS_COLLECTOR = "https://d.lilstts.com/events";

/**
 * `page`: its inputs are already resolved (`seo` and every block in
 * `sections`), so the page is its input.
 */
export const page = <P>(props: P): P => props;

/** `redirect`: returns its arguments as saved. */
export const redirect = (props: Redirect): Redirect => props;

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
  };
}

/**
 * `cms-settings`: the type of the well-known saved block `CMS`. Returns its
 * input with the telemetry and analytics defaults filled in; `preview` stays
 * as saved, since its default depends on code (`cms.settings()` applies it).
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
