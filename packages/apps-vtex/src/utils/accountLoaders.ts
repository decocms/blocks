/**
 * Pre-built section loaders for VTEX account pages.
 *
 * Every VTEX site with account pages repeats the same pattern:
 * 1. Extract VTEX cookies from request
 * 2. Call the VTEX user/profile/address/payment API
 * 3. Return enriched props with { device, logged, ...data }
 * 4. Catch errors gracefully (return logged: false)
 *
 * These factories encapsulate that boilerplate.
 *
 * @example
 * ```ts
 * import { vtexAccountLoaders } from "@decocms/apps/vtex/utils/accountLoaders";
 *
 * registerSectionLoaders({
 *   "site/sections/Account/PersonalData.tsx": vtexAccountLoaders.personalData(),
 *   "site/sections/Account/MyOrders.tsx":     vtexAccountLoaders.orders(),
 *   "site/sections/Account/Cards.tsx":        vtexAccountLoaders.cards(),
 *   "site/sections/Account/Addresses.tsx":    vtexAccountLoaders.addresses(),
 *   "site/sections/Account/Auth.tsx":         vtexAccountLoaders.authentication(),
 *   "site/sections/Account/Other.tsx":        vtexAccountLoaders.loggedIn(),
 * });
 * ```
 */

import { detectDevice } from "@decocms/blocks/sdk/useDevice";
import { getUserAddresses, type VtexAddress } from "../loaders/address";
import { getUserPayments, type Payment } from "../loaders/payment";
import { getCurrentProfile, type Profile } from "../loaders/profile";
import { getUser } from "../loaders/user";
import { getVtexCookies } from "./cookies";

type Device = "mobile" | "tablet" | "desktop";

type SectionLoaderFn = (
	props: Record<string, unknown>,
	req: Request,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

function getDevice(req: Request): Device {
	return detectDevice(req.headers.get("user-agent") ?? "");
}

// ---------------------------------------------------------------------------
// personalData — fetches full VTEX profile for personal data sections
// ---------------------------------------------------------------------------

export interface PersonalDataOptions {
	/** Extra custom profile fields to request beyond the standard set. */
	extraProfileFields?: string[];

	/**
	 * Transform the raw VTEX Profile into the shape your component expects.
	 * When omitted, the raw Profile object is returned as `profile`.
	 *
	 * @example
	 * ```ts
	 * vtexAccountLoaders.personalData({
	 *   mapProfile: (p) => ({
	 *     "@id": p.userId ?? p.id,
	 *     email: p.email,
	 *     givenName: p.firstName ?? null,
	 *     familyName: p.lastName ?? null,
	 *     taxID: p.document,
	 *   }),
	 * })
	 * ```
	 */
	mapProfile?: (profile: Profile) => Record<string, unknown>;
}

function personalData(options?: PersonalDataOptions): SectionLoaderFn {
	const { extraProfileFields, mapProfile } = options ?? {};
	return async (props, req) => {
		const cookie = getVtexCookies(req);
		try {
			const profile = await getCurrentProfile(cookie, extraProfileFields);
			const data = mapProfile ? mapProfile(profile) : profile;
			return {
				...props,
				device: getDevice(req),
				logged: !!profile,
				loading: false,
				userData: data,
			};
		} catch (error) {
			console.error("[accountLoaders.personalData]", error);
			return { ...props, device: getDevice(req), logged: false, loading: false, userData: null };
		}
	};
}

// ---------------------------------------------------------------------------
// orders — checks login status for order listing sections
// ---------------------------------------------------------------------------

function orders(): SectionLoaderFn {
	return async (props, req) => {
		const cookie = getVtexCookies(req);
		try {
			const userData = await getUser(cookie);
			return { ...props, device: getDevice(req), logged: !!userData };
		} catch {
			return { ...props, device: getDevice(req), logged: false };
		}
	};
}

// ---------------------------------------------------------------------------
// cards — fetches saved payment tokens for card management sections
// ---------------------------------------------------------------------------

function cards(): SectionLoaderFn {
	return async (props, req) => {
		const cookie = getVtexCookies(req);
		try {
			const user = await getUser(cookie);
			const logged = !!user;
			let payments: Payment[] = [];
			if (logged) {
				try {
					payments = (await getUserPayments(cookie)) ?? [];
				} catch {
					payments = [];
				}
			}
			return { ...props, logged, payments };
		} catch {
			return { ...props, logged: false, payments: [] };
		}
	};
}

// ---------------------------------------------------------------------------
// addresses — fetches address list for address management sections
// ---------------------------------------------------------------------------

function addresses(): SectionLoaderFn {
	return async (props, req) => {
		const cookie = getVtexCookies(req);
		try {
			const userData = await getUser(cookie);
			const logged = !!userData;
			let userAddressData: VtexAddress[] | null = null;
			if (logged) {
				try {
					userAddressData = await getUserAddresses(cookie);
				} catch {
					userAddressData = null;
				}
			}
			return { ...props, device: getDevice(req), logged, userAddressData };
		} catch {
			return { ...props, device: getDevice(req), logged: false, userAddressData: null };
		}
	};
}

// ---------------------------------------------------------------------------
// authentication — checks login + returns user data for auth pages
// ---------------------------------------------------------------------------

function authentication(): SectionLoaderFn {
	return async (props, req) => {
		const cookie = getVtexCookies(req);
		try {
			const userData = await getUser(cookie);
			return { ...props, device: getDevice(req), logged: !!userData, userData };
		} catch {
			return { ...props, device: getDevice(req), logged: false, userData: null };
		}
	};
}

// ---------------------------------------------------------------------------
// loggedIn — generic "is the user logged in?" loader
// ---------------------------------------------------------------------------

function loggedIn(): SectionLoaderFn {
	return async (props, req) => {
		const cookie = getVtexCookies(req);
		try {
			const userData = await getUser(cookie);
			return { ...props, device: getDevice(req), logged: !!userData };
		} catch {
			return { ...props, device: getDevice(req), logged: false };
		}
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const vtexAccountLoaders = {
	personalData,
	orders,
	cards,
	addresses,
	authentication,
	loggedIn,
} as const;
