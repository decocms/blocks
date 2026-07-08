/**
 * VTEX Address management actions (store-graphql).
 * Ported from deco-cx/apps:
 *   - vtex/actions/address/create.ts
 *   - vtex/actions/address/delete.ts
 *   - vtex/actions/address/update.ts
 * @see https://developers.vtex.com/docs/guides/profile-system
 */
import { getVtexConfig, vtexFetch } from "../client";
import { buildAuthCookieHeader } from "../utils/vtexId";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddressInput {
	addressName: string;
	addressType?: string;
	city?: string;
	complement?: string;
	country?: string;
	geoCoordinates?: number[];
	neighborhood?: string;
	number?: string;
	postalCode?: string;
	receiverName?: string;
	reference?: string;
	state?: string;
	street?: string;
}

export interface SavedAddress {
	id: string;
	cacheId: string;
	addressId: string;
	userId?: string;
	addressName: string;
	addressType: string | null;
	city: string | null;
	complement: string | null;
	country: string | null;
	geoCoordinates: number[] | null;
	neighborhood: string | null;
	number: string | null;
	postalCode: string | null;
	receiverName: string | null;
	reference: string | null;
	state: string | null;
	street: string | null;
	name?: string;
}

export interface DeleteAddressResult {
	cacheId: string;
	addresses: SavedAddress[];
}

export interface UpdateAddressResult {
	cacheId: string;
	addresses: SavedAddress;
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
// Mutations
// ---------------------------------------------------------------------------

const SAVE_ADDRESS = `mutation SaveAddress($address: AddressInput!) {
  saveAddress(address: $address) @context(provider: "vtex.store-graphql") {
    addressId
    cacheId
    id
    userId
    receiverName
    complement
    neighborhood
    country
    state
    number
    street
    geoCoordinates
    postalCode
    city
    name
    addressName
    addressType
  }
}`;

const DELETE_ADDRESS = `mutation DeleteAddress($addressId: String) {
  deleteAddress(id: $addressId) {
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
      reference
      state
      street
    }
  }
}`;

const UPDATE_ADDRESS = `mutation UpdateAddress($addressId: String!, $addressFields: AddressInput) {
  updateAddress(id: $addressId, fields: $addressFields) @context(provider: "vtex.store-graphql") {
    cacheId
    addresses: address {
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
      reference
      state
      street
    }
  }
}`;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Create a new user address. Requires the user's VtexIdclientAutCookie token. */
export async function createAddress(
	input: AddressInput,
	authCookie: string,
): Promise<SavedAddress> {
	const { saveAddress } = await gql<{ saveAddress: SavedAddress }>(
		SAVE_ADDRESS,
		{ address: input },
		authCookie,
	);
	return saveAddress;
}

/** Delete an address by its ID. Returns remaining addresses. */
export async function deleteAddress(
	addressId: string,
	authCookie: string,
): Promise<DeleteAddressResult> {
	const { deleteAddress: result } = await gql<{ deleteAddress: DeleteAddressResult }>(
		DELETE_ADDRESS,
		{ addressId },
		authCookie,
	);
	return result;
}

/** Update an existing address. Returns the updated address. */
export async function updateAddress(
	addressId: string,
	fields: Partial<AddressInput>,
	authCookie: string,
): Promise<UpdateAddressResult> {
	const { updateAddress: result } = await gql<{ updateAddress: UpdateAddressResult }>(
		UPDATE_ADDRESS,
		{
			addressId,
			addressFields: {
				...fields,
				receiverName: fields.receiverName ?? null,
				complement: fields.complement ?? null,
			},
		},
		authCookie,
	);
	return result;
}

// ---------------------------------------------------------------------------
// Request-aware wrappers (for COMMERCE_LOADERS / invoke proxy)
// Handle cookie extraction, postalCode sanitization, and field defaults.
// ---------------------------------------------------------------------------

import { ensureUnsuffixedAuthCookie, getVtexCookies } from "../utils/cookies";

function sanitizeAddressInput(props: Record<string, any>): Record<string, any> {
	if (props.postalCode) props.postalCode = props.postalCode.replace(/\D/g, "");
	if (!props.addressName) props.addressName = props.receiverName || `Address ${Date.now()}`;
	if (!props.addressType) props.addressType = "residential";
	return props;
}

export async function createAddressFromRequest(
	props: Record<string, any>,
	request: Request,
): Promise<SavedAddress> {
	const cookie = ensureUnsuffixedAuthCookie(getVtexCookies(request));
	return createAddress(sanitizeAddressInput(props) as AddressInput, cookie);
}

export async function updateAddressFromRequest(
	props: Record<string, any>,
	request: Request,
): Promise<UpdateAddressResult> {
	const cookie = ensureUnsuffixedAuthCookie(getVtexCookies(request));
	const { addressId, ...fields } = props;
	return updateAddress(addressId, fields, cookie);
}

export async function deleteAddressFromRequest(
	props: Record<string, any>,
	request: Request,
): Promise<DeleteAddressResult> {
	const cookie = ensureUnsuffixedAuthCookie(getVtexCookies(request));
	return deleteAddress(props.addressId, cookie);
}
