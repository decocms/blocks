/**
 * The Deco Analytics client (`startAnalytics` from
 * `@decocms/blocks/analytics/client`), started once per page after
 * hydration, with the tests the page rendered: the map the worker decided for
 * this request and `DecoDocument` published (`pageValues().experiments`).
 * Every event then carries each test's arm in `exp`, the first page view
 * included. A preview publishes no tests, so its events carry none.
 */
import { type AnalyticsClientOptions, startAnalytics } from "@decocms/blocks/analytics/client";
import { useEffect } from "react";
import { pageValues } from "./pageValues.ts";

/** `startAnalytics`'s options; the tests come from the page. */
export type DecoAnalyticsProps = Omit<AnalyticsClientOptions, "experiments">;

/** One client per page, however often the component mounts. */
let started = false;

/**
 * Starts the Deco Analytics client in the browser with the page's tests.
 * `DecoDocument` renders it for its `analytics` prop; a site with its own
 * document renders it once in the `<body>`, next to `DecoPreview`. Renders
 * nothing.
 */
export function DecoAnalytics(props: DecoAnalyticsProps): null {
  useEffect(() => {
    if (started) return;
    started = true;
    const { experiments } = pageValues();
    void startAnalytics({ ...props, ...(experiments ? { experiments } : {}) });
  });
  return null;
}
