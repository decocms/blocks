/**
 * What the worker handed this request's render (the CDN segment token, the
 * draft, whether the link's draft can't be read anymore, and the visitor's
 * tests), and the inline script that publishes it to the browser.
 */
import { currentScope } from "@decocms/tanstack/scope";
import { CSEG_GLOBAL } from "../shared.ts";

export const DRAFT_GLOBAL = "__DECO_DRAFT";
export const DRAFT_UNAVAILABLE_GLOBAL = "__DECO_DRAFT_UNAVAILABLE";
export const EXPERIMENTS_GLOBAL = "__DECO_EXPERIMENTS";

/**
 * The Deco Analytics tag's config (decocms/analytics): its `x` is the
 * experiment map the tag puts on every event it sends, and may be written
 * before the tag loads or after.
 */
const ANALYTICS_GLOBAL = "__dq";

export interface PageValues {
  cseg?: string;
  draft?: string;
  /** The link named a draft that can't be read anymore: the page shows the release. */
  draftUnavailable?: boolean;
  /** Each test on or off for the visitor, on the live site only. */
  experiments?: Readonly<Record<string, boolean>>;
}

/** Plain code-unit order, the same on every server and locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The tests as a record of booleans, sorted; undefined when there are none. */
function tests(value: unknown): Record<string, boolean> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out = Object.create(null) as Record<string, boolean>;
  for (const name of Object.keys(value).sort(byCodeUnit)) {
    const on = (value as Record<string, unknown>)[name];
    if (typeof on === "boolean") out[name] = on;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** On the server, the request scope; in the browser, what the server published on `window`. */
export function pageValues(): PageValues {
  if (typeof window !== "undefined") {
    const w = window as unknown as Record<string, unknown>;
    const pick = (k: string) =>
      typeof w[k] === "string" && w[k] !== "" ? (w[k] as string) : undefined;
    const values: PageValues = { cseg: pick(CSEG_GLOBAL), draft: pick(DRAFT_GLOBAL) };
    if (w[DRAFT_UNAVAILABLE_GLOBAL] === true) values.draftUnavailable = true;
    const experiments = tests(w[EXPERIMENTS_GLOBAL]);
    if (experiments) values.experiments = experiments;
    return values;
  }
  const scope = currentScope();
  const values: PageValues = { cseg: scope?.csegToken, draft: scope?.draft };
  if (scope?.draftUnavailable === true) values.draftUnavailable = true;
  const experiments = tests(scope?.experiments);
  if (experiments) values.experiments = experiments;
  return values;
}

/**
 * The script that publishes `pageValues()`; the same markup on the server and in the browser.
 *
 * The tests go on `window.__DECO_EXPERIMENTS` and, as `on`/`off`, into the
 * Deco Analytics tag's experiment map (`window.__dq.x`), merged over what is
 * there, so every event the tag sends from this page, the first page view
 * included, carries the arm the page rendered. The tag sends nothing for a
 * name its contract refuses (lowercase letters, digits, `-` and `_`).
 */
export function publishScript(values: PageValues): string | null {
  const parts: string[] = [];
  // JSON.stringify keeps the values inert; `<` is escaped so they can't close the script.
  const literal = (v: string) => JSON.stringify(v).replace(/</g, "\\u003c");
  // Parsed rather than written as an object literal, so any name is an own property.
  const object = (v: Record<string, unknown>) => `JSON.parse(${literal(JSON.stringify(v))})`;
  if (values.cseg) parts.push(`window.${CSEG_GLOBAL}=${literal(values.cseg)}`);
  if (values.draft) parts.push(`window.${DRAFT_GLOBAL}=${literal(values.draft)}`);
  if (values.draftUnavailable) parts.push(`window.${DRAFT_UNAVAILABLE_GLOBAL}=true`);
  const experiments = tests(values.experiments);
  if (experiments) {
    const arms = Object.create(null) as Record<string, string>;
    for (const name of Object.keys(experiments)) arms[name] = experiments[name] ? "on" : "off";
    parts.push(`window.${EXPERIMENTS_GLOBAL}=${object(experiments)}`);
    parts.push(
      `(function(d){d.x=Object.assign({},d.x,${object(arms)})})(window.${ANALYTICS_GLOBAL}=window.${ANALYTICS_GLOBAL}||{})`,
    );
  }
  return parts.length ? parts.join(";") : null;
}
