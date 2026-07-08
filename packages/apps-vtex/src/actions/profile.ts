/**
 * VTEX Profile update action (store-graphql).
 * Ported from deco-cx/apps:
 *   - vtex/actions/profile/updateProfile.ts
 * @see https://developers.vtex.com/docs/guides/profile-system
 */
import { getVtexConfig, getVtexFetch, vtexFetch } from "../client";
import { buildAuthCookieHeader } from "../utils/vtexId";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileInput {
	firstName?: string;
	lastName?: string;
	birthDate?: string;
	gender?: string;
	homePhone?: string;
	businessPhone?: string;
	document?: string;
	email: string;
	tradeName?: string;
	corporateName?: string;
	corporateDocument?: string;
	stateRegistration?: string;
	isCorporate?: boolean;
}

export interface Profile {
	cacheId: string;
	firstName: string;
	lastName: string;
	birthDate: string;
	gender: string;
	homePhone: string;
	businessPhone: string;
	document: string;
	email: string;
	tradeName: string;
	corporateName: string;
	corporateDocument: string;
	stateRegistration: string;
	isCorporate: boolean;
}

// ---------------------------------------------------------------------------
// GraphQL helper (myvtex.com private graphql)
// ---------------------------------------------------------------------------

interface GqlResponse<T> {
	data: T;
	errors?: Array<{ message: string }>;
}

async function gql<T>(
	query: string,
	variables: Record<string, unknown>,
	authCookie: string,
): Promise<T> {
	const { account } = getVtexConfig();
	const result = await vtexFetch<GqlResponse<T>>(
		`https://${account}.myvtex.com/_v/private/graphql/v1`,
		{
			method: "POST",
			body: JSON.stringify({ query, variables }),
			headers: { Cookie: buildAuthCookieHeader(authCookie, account) },
		},
	);
	if (result.errors?.length) {
		throw new Error(`GraphQL error: ${result.errors[0].message}`);
	}
	return result.data;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

const UPDATE_PROFILE = `mutation UpdateProfile($input: ProfileInput!) {
  updateProfile(fields: $input) @context(provider: "vtex.store-graphql") {
    cacheId
    firstName
    lastName
    birthDate
    gender
    homePhone
    businessPhone
    document
    email
    tradeName
    corporateName
    corporateDocument
    stateRegistration
    isCorporate
  }
}`;

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Update user profile.
 * The original Deco action extracted `email` from the auth cookie payload.
 * Here the caller must provide it explicitly.
 */
export async function updateProfile(
	fields: Omit<ProfileInput, "email">,
	email: string,
	authCookie: string,
): Promise<Profile> {
	const { updateProfile: profile } = await gql<{ updateProfile: Profile }>(
		UPDATE_PROFILE,
		{ input: { ...fields, email } },
		authCookie,
	);
	return profile;
}

// ---------------------------------------------------------------------------
// Request-aware wrappers (for COMMERCE_LOADERS / invoke proxy)
// ---------------------------------------------------------------------------

import { getCurrentProfile } from "../loaders/profile";
import { getVtexCookies } from "../utils/cookies";
import { deletePaymentToken } from "./misc";
import { updateNewsletterOptIn } from "./newsletter";

/**
 * Normalize birthDate strings to ISO 8601.
 * Handles dd/mm/yyyy (Brazilian format), yyyy-mm-dd, and full ISO.
 */
function normalizeBirthDate(profile: Record<string, any>): void {
	if (!profile.birthDate || typeof profile.birthDate !== "string") return;
	const ddmmyyyy = profile.birthDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
	if (ddmmyyyy) {
		profile.birthDate = `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}T00:00:00.000Z`;
	} else if (!profile.birthDate.includes("T")) {
		const isoMatch = profile.birthDate.match(/(\d{4})-(\d{2})-(\d{2})/);
		if (isoMatch) {
			profile.birthDate = `${isoMatch[0]}T00:00:00.000Z`;
		}
	}
}

/**
 * Update user profile via VTEX IO GraphQL. Handles cookie extraction,
 * birthDate normalization, and undefined-key cleanup.
 */
export async function updateProfileFromRequest(
	props: Record<string, any>,
	request: Request,
): Promise<any> {
	const { account } = getVtexConfig();
	const cookie = getVtexCookies(request);
	const profile = { ...props };
	normalizeBirthDate(profile);
	for (const key of Object.keys(profile)) {
		if (profile[key] === undefined) delete profile[key];
	}
	const QUERY = `mutation UpdateProfile($profile: ProfileInput!) {
		updateProfile(fields: $profile) @context(provider: "vtex.store-graphql@2.x") {
			cacheId firstName lastName email document gender homePhone
			businessPhone birthDate isCorporate corporateName
			corporateDocument tradeName stateRegistration
		}
	}`;
	const res = await getVtexFetch()(`https://${account}.myvtex.com/_v/private/graphql/v1`, {
		method: "POST",
		body: JSON.stringify({ query: QUERY, variables: { profile } }),
		headers: { "Content-Type": "application/json", cookie },
		operation: "io.graphql.UpdateProfile",
	});
	return res.json();
}

export async function newsletterProfileFromRequest(
	props: Record<string, any>,
	request: Request,
): Promise<any> {
	const cookie = request.headers.get("cookie") ?? "";
	return updateNewsletterOptIn(props.isNewsletterOptIn, props.email, cookie);
}

export async function deletePaymentFromRequest(
	props: Record<string, any>,
	request: Request,
): Promise<any> {
	const cookie = getVtexCookies(request);
	return deletePaymentToken(props.id, cookie);
}

export async function getPasswordLastUpdate(
	_props: Record<string, any>,
	request: Request,
): Promise<string | null> {
	const cookie = getVtexCookies(request);
	const profile = await getCurrentProfile(cookie);
	return profile?.passwordLastUpdate ?? null;
}
