import { withFetchTimeout } from "@decocms/blocks/sdk/fetchTimeout";
import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { getCheckoutUrl } from "../client";
import type { UserAuthenticate } from "./client";
import { getUserCookie } from "./user";

const fetchSafe = withFetchTimeout();

/**
 * Exchange the `fbits-login` cookie for a Wake `CustomerAccessToken` via the
 * checkout REST endpoint `GET /api/Login/Get`, forwarding the incoming request
 * headers (cookies) so Wake can resolve the logged-in customer.
 *
 * Returns `null` when there is no login cookie or the exchange fails.
 */
const authenticate = async (): Promise<string | null> => {
  const req = RequestContext.current?.request;
  if (!req) return null;

  const loginCookie = getUserCookie(req.headers);
  if (!loginCookie) return null;

  try {
    // Forward only the Cookie header (carries `fbits-login`) rather than the
    // whole incoming header set — the checkout endpoint only needs the session
    // cookie to resolve the customer.
    const forwardHeaders = new Headers();
    const cookie = req.headers.get("cookie");
    if (cookie) forwardHeaders.set("cookie", cookie);

    const response = await fetchSafe(new URL("/api/Login/Get", getCheckoutUrl()).href, {
      headers: forwardHeaders,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as UserAuthenticate | null;
    return data?.CustomerAccessToken ?? null;
  } catch {
    return null;
  }
};

export default authenticate;
