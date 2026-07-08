/**
 * VTEX Address API loaders.
 * Pure async functions — require configureVtex() to have been called.
 *
 * Ported from deco-cx/apps:
 *   vtex/loaders/address/getAddressByPostalCode.ts
 *   vtex/loaders/address/getUserAddresses.ts
 *
 * @see https://developers.vtex.com/docs/api-reference/checkout-api
 */
import { vtexFetch, vtexIOGraphQL } from "../client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostalAddress {
	"@type": "PostalAddress";
	postalCode?: string;
	addressLocality?: string;
	addressRegion?: string;
	addressCountry?: string;
	streetAddress?: string;
	identifier?: string;
	areaServed?: string;
	description?: string;
	disambiguatingDescription?: string;
	latitude?: number;
	longitude?: number;
}

export interface VtexAddress {
	addressId: string;
	addressType: string;
	addressName: string;
	city: string;
	complement: string;
	country: string;
	neighborhood: string;
	number: string;
	postalCode: string;
	geoCoordinates: number[];
	receiverName: string;
	state: string;
	street: string;
}

// ---------------------------------------------------------------------------
// getAddressByPostalCode
// ---------------------------------------------------------------------------

/**
 * Look up a postal address by country + postal code (public API).
 * @see https://developers.vtex.com/docs/api-reference/checkout-api#get-/api/checkout/pub/postal-code/-countryCode-/-postalCode-
 */
export async function getAddressByPostalCode(
	countryCode: string,
	postalCode: string,
): Promise<PostalAddress> {
	const data = await vtexFetch<Record<string, any>>(
		`/api/checkout/pub/postal-code/${countryCode}/${postalCode}`,
	);

	return {
		"@type": "PostalAddress",
		postalCode: data.postalCode,
		addressLocality: data.city,
		addressRegion: data.state,
		addressCountry: data.country,
		streetAddress: data.street || undefined,
		identifier: data.number || undefined,
		areaServed: data.neighborhood || undefined,
		description: data.complement || undefined,
		disambiguatingDescription: data.reference || undefined,
		latitude: data.geoCoordinates?.[0] ?? undefined,
		longitude: data.geoCoordinates?.[1] ?? undefined,
	};
}

// ---------------------------------------------------------------------------
// getUserAddresses (authenticated — VTEX IO GraphQL)
// ---------------------------------------------------------------------------

const USER_ADDRESSES_QUERY = `query Addresses @context(scope: "private") {
  profile {
    cacheId
    addresses {
      addressId: id
      addressType
      addressName
      city
      complement
      country
      neighborhood
      number
      postalCode
      geoCoordinates
      receiverName
      state
      street
    }
  }
}`;

/**
 * Fetch addresses for the currently authenticated user.
 * Requires a valid VTEX auth cookie.
 */
export async function getUserAddresses(authCookie: string): Promise<VtexAddress[]> {
	const { profile } = await vtexIOGraphQL<{
		profile: { addresses: VtexAddress[] };
	}>({ query: USER_ADDRESSES_QUERY }, { cookie: authCookie });

	return profile?.addresses ?? [];
}
