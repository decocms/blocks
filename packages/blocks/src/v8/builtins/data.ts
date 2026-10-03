import type { Analytics, Redirect, Telemetry } from "../types";

/** The hosted Deco CMS collector: where page views go when `collector` is left out. */
export const HOSTED_ANALYTICS_COLLECTOR = "https://d.lilstts.com/events";

/**
 * `page`: its inputs are already resolved (`seo` and every block in
 * `sections`), so the page is its input.
 */
export const page = <P>(props: P): P => props;

/** `redirect`: returns its arguments as saved. */
export const redirect = (props: Redirect): Redirect => props;

/** `telemetry`: the type of the well-known `Telemetry` saved block; returns its arguments. */
export const telemetry = (props: Telemetry = {}): Telemetry => props;

/** `analytics`: returns its input with the defaults filled in. */
export const analytics = (props: Analytics = {}): Required<Analytics> => ({
  ...props,
  collector: props.collector ?? HOSTED_ANALYTICS_COLLECTOR,
  enabled: props.enabled ?? true,
});
