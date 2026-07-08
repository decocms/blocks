/**
 * VTEX Session API loaders.
 * Pure async functions — require configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/session/getSession.ts
 *   vtex/loaders/session/getUserSessions.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/session-manager-api
 */
import { vtexFetch, vtexIOGraphQL } from "../client";

// ---------------------------------------------------------------------------
// getSession (REST)
// ---------------------------------------------------------------------------

/**
 * Fetch the current session data.
 *
 * @param items - Keys to retrieve, e.g. `["public.variable1", "profile.email"]`.
 *                Pass `["*"]` (or omit) to retrieve all keys.
 * @param authCookie - The raw `cookie` header value forwarded from the user request.
 *
 * @see https://developers.vtex.com/docs/api-reference/session-manager-api#get-/api/sessions
 */
export async function getSession<T = any>(items: string[] = ["*"], authCookie: string): Promise<T> {
	const qs = new URLSearchParams({ items: items.join(",") });
	return vtexFetch<T>(`/api/sessions?${qs}`, {
		headers: { cookie: authCookie },
	});
}

// ---------------------------------------------------------------------------
// getUserSessions (authenticated — VTEX IO GraphQL)
// ---------------------------------------------------------------------------

export interface LoginSession {
	id: string;
	cacheId: string;
	deviceType: string;
	city: string;
	lastAccess: string;
	browser: string;
	os: string;
	ip: string;
	fullAddress: string;
	firstAccess: string;
}

export interface LoginSessionsInfo {
	currentLoginSessionId: string;
	loginSessions: LoginSession[];
}

const USER_SESSIONS_QUERY = `query getUserSessions {
  loginSessionsInfo {
    currentLoginSessionId
    loginSessions {
      id
      cacheId
      deviceType
      city
      lastAccess
      browser
      os
      ip
      fullAddress
      firstAccess
    }
  }
}`;

/**
 * Fetch all active login sessions for the currently authenticated user.
 * Requires a valid VTEX auth cookie.
 */
export async function getUserSessions(authCookie: string): Promise<LoginSessionsInfo> {
	const { loginSessionsInfo } = await vtexIOGraphQL<{
		loginSessionsInfo: LoginSessionsInfo;
	}>({ query: USER_SESSIONS_QUERY }, { cookie: authCookie });

	return loginSessionsInfo;
}
