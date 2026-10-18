/**
 * What the worker handed this request's render (the CDN segment token and the
 * draft), and the inline script that publishes it to the browser.
 */
import { currentScope } from "@decocms/tanstack/scope";
import { CSEG_GLOBAL } from "../shared.ts";

export const DRAFT_GLOBAL = "__DECO_DRAFT";

export interface PageValues {
  cseg?: string;
  draft?: string;
}

/** On the server, the request scope; in the browser, what the server published on `window`. */
export function pageValues(): PageValues {
  if (typeof window !== "undefined") {
    const w = window as unknown as Record<string, unknown>;
    const pick = (k: string) =>
      typeof w[k] === "string" && w[k] !== "" ? (w[k] as string) : undefined;
    return { cseg: pick(CSEG_GLOBAL), draft: pick(DRAFT_GLOBAL) };
  }
  const scope = currentScope();
  return { cseg: scope?.csegToken, draft: scope?.draft };
}

/** The script that publishes `pageValues()`; the same markup on the server and in the browser. */
export function publishScript(values: PageValues): string | null {
  const parts: string[] = [];
  // JSON.stringify keeps the values inert; `<` is escaped so they can't close the script.
  const literal = (v: string) => JSON.stringify(v).replace(/</g, "\\u003c");
  if (values.cseg) parts.push(`window.${CSEG_GLOBAL}=${literal(values.cseg)}`);
  if (values.draft) parts.push(`window.${DRAFT_GLOBAL}=${literal(values.draft)}`);
  return parts.length ? parts.join(";") : null;
}
