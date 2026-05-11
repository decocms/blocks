import type { MatcherContext } from "../core/cms/resolve";

function parseCookieHeader(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Build a framework-agnostic MatcherContext from a Next.js (or any standard
 * Web API) Request. Pair with loadCmsPagePure / resolveDeferredSectionPure.
 */
export function buildMatcherContextFromNext(req: Request): MatcherContext {
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headers[k] = v;
  return {
    userAgent: req.headers.get("user-agent") ?? "",
    url: req.url,
    path: url.pathname,
    cookies: parseCookieHeader(req.headers.get("cookie")),
    headers,
    request: req,
  };
}
