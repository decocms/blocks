/**
 * v7's website matchers in the block map. `@decocms/compat-v7/matchers` has
 * each one with v7's results, taking the request explicitly; the binding's
 * compat subpath gives that request (`matcherContext()`, with one A/B
 * decision list per request). The block map registers each matcher the
 * content uses under its v7 name. v7's random matcher isn't one of them: the
 * content step turns it into the saved block `experiments` and `experiment`
 * rules (./experiments.ts), so the binding is the only writer of the
 * visitor's `deco_segment`; nor is its date matcher, which becomes the saved
 * block `campaigns` and `date` rules (./campaigns.ts).
 */
import type { Framework } from "./framework";

/** The matchers @decocms/compat-v7/matchers ports, with their props type; `request: false` reads none. */
const MATCHERS: Record<string, { props: string; request: boolean }> = {
  cookie: { props: "CookieProps", request: true },
  device: { props: "DeviceProps", request: true },
  environment: { props: "never", request: false },
  host: { props: "HostProps", request: true },
  location: { props: "LocationProps", request: true },
  multi: { props: "MultiProps", request: false },
  pathname: { props: "PathnameProps", request: true },
  queryString: { props: "QueryStringProps", request: true },
};

/** The matcher a v7 type name (`website/matchers/device.ts`, with or without `.ts`) names, if ported. */
export function v7Matcher(type: string): string | undefined {
  const name = /^website\/matchers\/([A-Za-z]+)(?:\.ts)?$/.exec(type)?.[1];
  return name && Object.hasOwn(MATCHERS, name) ? name : undefined;
}

/** The block map's function for one matcher. */
export function matcherEntry(matcher: string, framework: Framework): string {
  const { props, request } = MATCHERS[matcher];
  if (!request) return `(props: matchers.${props}) => matchers.${matcher}(props)`;
  return framework === "tanstack"
    ? `(props: matchers.${props}) => matchers.${matcher}(props, matcherInput())`
    : `async (props: matchers.${props}) => matchers.${matcher}(props, await matcherContext())`;
}

export const V7_MATCHER_HINT =
  "a v7 matcher: @decocms/compat-v7/matchers has v7's (device, cookie, host, pathname, queryString, location, multi), taking the request; the script registers them on a TanStack Start or Next.js site, through matcherContext() from @decocms/compat-v7/tanstack/server or /nextjs/server. Elsewhere register it under this name with the request your framework gives (/next/matchers-and-variants#matchers); v7's environment matcher read the process environment, which v8 never does: write one in the site that knows where it runs. A random matcher left here belongs in the saved block experiments (type split-traffic), read by the experiment rule ({ name }) (/next/built-in-blocks#split-traffic)";
