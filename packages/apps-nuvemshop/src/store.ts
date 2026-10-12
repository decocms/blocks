/**
 * The store's own (theme) session endpoints — the parts the Storefront API
 * doesn't cover: login, logout and the logged-in account page.
 *
 * The session lives in the store's cookies (`store_session_payload_<id>`,
 * `store_login_session`, …). We forward only those (`store_*`) upstream —
 * never the site's own cookies — and re-emit the store's `Set-Cookie` on our
 * domain through `RequestContext.responseHeaders`, so the browser keeps one
 * session that follows it across our pages.
 */
import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { getNuvemshopConfig, nuvemshopFetch } from "./client";

const STORE_COOKIE = /^store_/;

export function storeOrigin(): string {
  const { storeUrl } = getNuvemshopConfig();
  if (!storeUrl) throw new Error("Nuvemshop storeUrl is not configured (the store's own domain)");
  return new URL(storeUrl).origin;
}

/** `store_*` cookies of the current request, as a Cookie header ("" when none). */
export function storeCookies(): string {
  const raw = RequestContext.current?.request.headers.get("cookie") ?? "";
  return raw
    .split(/;\s*/)
    .filter((c) => STORE_COOKIE.test(c))
    .join("; ");
}

function rewriteDomain(cookie: string, host: string | null) {
  return host
    ? cookie.replace(/(;\s*)domain=[^;]*/i, `$1Domain=${host}`)
    : cookie.replace(/;\s*domain=[^;]*/gi, "");
}

/** Merge upstream Set-Cookie values into a Cookie header (for follow-up calls in the same action). */
function mergeCookies(header: string, setCookies: string[]) {
  const jar = new Map(header ? header.split(/;\s*/).map((c) => [c.split("=")[0], c] as const) : []);
  for (const s of setCookies) {
    const kv = s.split(";")[0];
    const name = kv.split("=")[0];
    if (STORE_COOKIE.test(name)) jar.set(name, kv);
  }
  return [...jar.values()].join("; ");
}

export interface StoreResponse {
  status: number;
  location: string | null;
  text: () => Promise<string>;
}

/**
 * Calls the store with the buyer's store session and forwards any new
 * session cookies to the browser. `cookie` overrides the request's cookies
 * (used to chain calls inside one action). Redirects are not followed.
 */
export async function storeFetch(
  path: string,
  init: { method?: "GET" | "POST"; form?: Record<string, string>; cookie?: string } = {},
): Promise<StoreResponse & { cookie: string }> {
  const origin = storeOrigin();
  const cookie = init.cookie ?? storeCookies();
  const headers: Record<string, string> = { origin, referer: `${origin}${path}` };
  if (init.form) headers["content-type"] = "application/x-www-form-urlencoded";
  if (cookie) headers.cookie = cookie;
  const res = await nuvemshopFetch(`${origin}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.form ? new URLSearchParams(init.form).toString() : undefined,
    redirect: "manual",
  });
  const setCookies = res.headers.getSetCookie();
  const ctx = RequestContext.current;
  if (ctx) {
    const host = new URL(ctx.request.url).hostname;
    for (const c of setCookies) {
      if (STORE_COOKIE.test(c)) ctx.responseHeaders.append("set-cookie", rewriteDomain(c, host));
    }
  }
  return {
    status: res.status,
    location: res.headers.get("location"),
    text: () => res.text(),
    cookie: mergeCookies(cookie, setCookies),
  };
}
