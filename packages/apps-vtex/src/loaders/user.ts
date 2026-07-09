/**
 * VTEX User API loader.
 * Pure async function — requires configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/user.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/checkout-api
 */
import { vtexIOGraphQL } from "../client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Person {
	"@id": string;
	email: string;
	givenName?: string;
	familyName?: string;
	taxID?: string;
	gender?: string;
	telephone?: string;
}

interface VtexUser {
	id: string;
	userId: string;
	email: string;
	firstName?: string;
	lastName?: string;
	profilePicture?: string;
	gender?: string;
	document?: string;
	homePhone?: string;
	businessPhone?: string;
}

// ---------------------------------------------------------------------------
// getUser (authenticated — VTEX IO GraphQL)
// ---------------------------------------------------------------------------

const USER_QUERY = `query getUserProfile {
  profile {
    id
    userId
    email
    firstName
    lastName
    profilePicture
    gender
    document
    homePhone
    businessPhone
  }
}`;

/**
 * Fetch the authenticated user as a Schema.org-style `Person`.
 * Returns `null` when no valid session exists or the query fails.
 *
 * @param authCookie - Raw `cookie` header value from the user request.
 */
export async function getUser(authCookie: string): Promise<Person | null> {
	try {
		const { profile: user } = await vtexIOGraphQL<{ profile: VtexUser }>(
			{ query: USER_QUERY },
			{ cookie: authCookie },
		);

		return {
			"@id": user.userId ?? user.id,
			email: user.email,
			givenName: user.firstName,
			familyName: user.lastName,
			taxID: user.document?.replace(/[^\d]/g, ""),
			gender: user.gender
				? user.gender === "f"
					? "https://schema.org/Female"
					: "https://schema.org/Male"
				: undefined,
			telephone: user.homePhone ?? user.businessPhone,
		};
	} catch {
		return null;
	}
}
