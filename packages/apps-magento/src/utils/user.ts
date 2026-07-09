/**
 * Reads the Magento PHP session cookie from a request's headers.
 * Returns undefined when the cookie is absent (anonymous visitor).
 *
 * Mirrors `deco-cx/apps/magento/utils/user.ts` — the Fresh version
 * used Deno's `std/http/cookie` getCookies; the port goes through
 * `@decocms/blocks/sdk/cookie` so it works on Cloudflare Workers and
 * Node alike.
 */
import { getCookies } from "@decocms/blocks/sdk/cookie";
import { SESSION_COOKIE } from "./constants";

export const getUserCookie = (headers: Headers): string | undefined => {
	const cookies = getCookies(headers);
	return cookies[SESSION_COOKIE];
};
