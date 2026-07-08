/**
 * VTEX Profile API loaders.
 * Pure async functions — require configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/profile/getCurrentProfile.ts
 *   vtex/loaders/profile/getProfileByEmail.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/checkout-api
 */
import { vtexFetch, vtexIOGraphQL } from "../client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ADDRESS_FIELDS = `
  addressType
  receiverName
  addressId
  postalCode
  city
  state
  country
  street
  number
  neighborhood
  complement
  reference
  geoCoordinates
`;

export interface Profile {
	id: string;
	cacheId: string;
	email: string;
	firstName: string;
	lastName: string;
	document: string;
	userId: string;
	birthDate: string;
	gender: string;
	homePhone: string;
	businessPhone: string;
	addresses: Record<string, unknown>[];
	isCorporate: boolean;
	tradeName: string;
	corporateName: string;
	corporateDocument: string;
	stateRegistration: string;
	payments: Record<string, unknown>[];
	customFields: Array<{ key: string; value: string }>;
	passwordLastUpdate: string;
}

// ---------------------------------------------------------------------------
// getCurrentProfile (authenticated — VTEX IO GraphQL)
// ---------------------------------------------------------------------------

const PROFILE_QUERY = `query getUserProfile($customFields: String) {
  profile(customFields: $customFields) {
    id
    cacheId
    email
    firstName
    lastName
    document
    userId
    birthDate
    gender
    homePhone
    businessPhone
    addresses { ${ADDRESS_FIELDS} }
    isCorporate
    tradeName
    corporateName
    corporateDocument
    stateRegistration
    payments {
      cacheId
      id
      paymentSystem
      paymentSystemName
      cardNumber
      address { ${ADDRESS_FIELDS} }
      isExpired
      expirationDate
      accountStatus
    }
    customFields {
      key
      value
    }
    passwordLastUpdate
  }
}`;

/**
 * Fetch the full profile for the currently authenticated user.
 * Requires a valid VTEX auth cookie.
 */
export async function getCurrentProfile(
	authCookie: string,
	customFields?: string[],
): Promise<Profile> {
	const { profile } = await vtexIOGraphQL<{ profile: Profile }>(
		{
			query: PROFILE_QUERY,
			variables: { customFields: customFields?.join(",") },
		},
		{ cookie: authCookie },
	);

	return profile;
}

// ---------------------------------------------------------------------------
// getProfileByEmail (authenticated — REST)
// ---------------------------------------------------------------------------

/**
 * Fetch a checkout profile by e-mail.
 * Requires a valid VTEX auth cookie.
 *
 * @see https://developers.vtex.com/docs/api-reference/checkout-api#get-/api/checkout/pub/profiles
 */
export async function getProfileByEmail<T = any>(
	email: string,
	authCookie: string,
	ensureComplete?: boolean,
): Promise<T> {
	const params = new URLSearchParams({ email });
	if (ensureComplete) params.set("ensureComplete", "true");

	return vtexFetch<T>(`/api/checkout/pub/profiles?${params}`, {
		headers: { cookie: authCookie },
	});
}
