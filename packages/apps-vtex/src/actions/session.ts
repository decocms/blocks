/**
 * VTEX Sessions API actions.
 * Cookie forwarding happens automatically via RequestContext.responseHeaders.
 */

import { getVtexConfig, vtexFetchWithCookies, vtexIOGraphQL } from "../client";
import { buildAuthCookieHeader } from "../utils/vtexId";

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

export interface SessionData {
	id: string;
	namespaces: Record<string, Record<string, { value: string }>>;
}

export interface CreateSessionProps {
	data: Record<string, any>;
}

export async function createSession(props: CreateSessionProps): Promise<SessionData> {
	const { data } = props;
	return vtexFetchWithCookies<SessionData>("/api/sessions", {
		method: "POST",
		body: JSON.stringify(data),
	});
}

// ---------------------------------------------------------------------------
// editSession
// ---------------------------------------------------------------------------

export interface EditSessionResponse {
	id: string;
	namespaces: Record<string, Record<string, { value: string }>>;
}

export interface EditSessionProps {
	public: Record<string, { value: string }>;
}

/**
 * Edit the current VTEX session (public properties).
 */
export async function editSession(props: EditSessionProps): Promise<EditSessionResponse> {
	return vtexFetchWithCookies<EditSessionResponse>("/api/sessions", {
		method: "PATCH",
		body: JSON.stringify({ public: { ...props.public } }),
	});
}

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

export interface DeleteSessionResponse {
	logOutFromSession: string;
}

const DELETE_SESSION_MUTATION = `mutation LogOutFromSession($sessionId: ID) {
  logOutFromSession(sessionId: $sessionId) @context(provider: "vtex.store-graphql@2.x")
}`;

export interface DeleteSessionProps {
	sessionId: string;
	authCookie: string;
}

/**
 * Log out / delete a VTEX session via the store-graphql mutation.
 * Requires a valid auth cookie.
 */
export async function deleteSession(props: DeleteSessionProps): Promise<DeleteSessionResponse> {
	const { sessionId, authCookie } = props;
	if (!authCookie) throw new Error("Auth cookie is required to delete session");
	const { account } = getVtexConfig();
	return vtexIOGraphQL<DeleteSessionResponse>(
		{
			query: DELETE_SESSION_MUTATION,
			variables: { sessionId },
		},
		{ cookie: buildAuthCookieHeader(authCookie, account) },
	);
}
