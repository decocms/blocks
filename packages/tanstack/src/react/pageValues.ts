/**
 * What the worker handed this request's render (the CDN segment token, the
 * draft, whether the link's draft can't be read anymore, and the live site's
 * tests), and the inline script that publishes it to the browser.
 */
import { currentScope } from "@decocms/tanstack/scope";
import { CSEG_GLOBAL } from "../shared.ts";

export const DRAFT_GLOBAL = "__DECO_DRAFT";
export const DRAFT_UNAVAILABLE_GLOBAL = "__DECO_DRAFT_UNAVAILABLE";
export const EXPERIMENTS_GLOBAL = "__DECO_EXPERIMENTS";

export interface PageValues {
  cseg?: string;
  draft?: string;
  /** The link named a draft that can't be read anymore: the page shows the release. */
  draftUnavailable?: boolean;
  /** Each test on or off as the page renders it, on the live site only (never a preview). */
  experiments?: Readonly<Record<string, boolean>>;
}

/** The boolean entries of `value`, or undefined when there are none. */
function testsOf(value: unknown): Record<string, boolean> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const tests = Object.create(null) as Record<string, boolean>;
  for (const name of Object.keys(value)) {
    const on = (value as Record<string, unknown>)[name];
    if (typeof on === "boolean") tests[name] = on;
  }
  return Object.keys(tests).length ? tests : undefined;
}

/** On the server, the request scope; in the browser, what the server published on `window`. */
export function pageValues(): PageValues {
  if (typeof window !== "undefined") {
    const w = window as unknown as Record<string, unknown>;
    const pick = (k: string) =>
      typeof w[k] === "string" && w[k] !== "" ? (w[k] as string) : undefined;
    const values: PageValues = { cseg: pick(CSEG_GLOBAL), draft: pick(DRAFT_GLOBAL) };
    if (w[DRAFT_UNAVAILABLE_GLOBAL] === true) values.draftUnavailable = true;
    const experiments = testsOf(w[EXPERIMENTS_GLOBAL]);
    if (experiments) values.experiments = experiments;
    return values;
  }
  const scope = currentScope();
  const values: PageValues = { cseg: scope?.csegToken, draft: scope?.draft };
  if (scope?.draftUnavailable === true) values.draftUnavailable = true;
  const experiments = testsOf(scope?.experiments);
  if (experiments) values.experiments = experiments;
  return values;
}

/** The script that publishes `pageValues()`; the same markup on the server and in the browser. */
export function publishScript(values: PageValues): string | null {
  const parts: string[] = [];
  // JSON.stringify keeps the values inert; `<` is escaped so they can't close the script.
  const literal = (v: string) => JSON.stringify(v).replace(/</g, "\\u003c");
  if (values.cseg) parts.push(`window.${CSEG_GLOBAL}=${literal(values.cseg)}`);
  if (values.draft) parts.push(`window.${DRAFT_GLOBAL}=${literal(values.draft)}`);
  if (values.draftUnavailable) parts.push(`window.${DRAFT_UNAVAILABLE_GLOBAL}=true`);
  if (values.experiments && Object.keys(values.experiments).length) {
    // Through JSON.parse, so a test named `__proto__` stays an ordinary key.
    const tests = literal(JSON.stringify(values.experiments));
    parts.push(`window.${EXPERIMENTS_GLOBAL}=JSON.parse(${tests})`);
  }
  return parts.length ? parts.join(";") : null;
}
