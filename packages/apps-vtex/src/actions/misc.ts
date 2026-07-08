/**
 * Miscellaneous VTEX actions that don't warrant their own module.
 * Ported from deco-cx/apps:
 *   - vtex/actions/notifyme.ts
 *   - vtex/actions/analytics/sendEvent.ts
 *   - vtex/actions/review/submit.ts
 *   - vtex/actions/payment/deletePaymentToken.ts
 * @see https://developers.vtex.com/docs/api-reference
 */
import { getVtexConfig, getVtexFetch, vtexFetch } from "../client";
import { buildAuthCookieHeader, VTEX_AUTH_COOKIE } from "../utils/vtexId";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotifyMeProps {
	email: string;
	skuId: string;
	name?: string;
}

export interface ReviewData {
	productId: string;
	rating: number;
	title: string;
	text: string;
	reviewerName: string;
	approved: boolean;
}

export type AnalyticsEvent =
	| {
			type: "session.ping";
			url: string;
	  }
	| {
			type: "page.cart";
			products: { productId: string; quantity: number }[];
	  }
	| {
			type: "page.empty_cart";
			products: Record<string, never>;
	  }
	| {
			type: "page.confirmation";
			order: string;
			products: { productId: string; quantity: number; price: number }[];
	  }
	| {
			type: "search.click";
			position: number;
			text: string;
			productId: string;
			url: string;
	  }
	| {
			type: "search.query";
			url: string;
			text: string;
			misspelled: boolean;
			match: number;
			operator: string;
			locale: string;
	  };

export interface ISCookies {
	anonymous: string;
	session: string;
}

export interface DeletePaymentTokenResult {
	deletePaymentToken: boolean;
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

const DELETE_PAYMENT_TOKEN = `mutation DeleteCreditCardToken($tokenId: ID!) {
  deletePaymentToken(tokenId: $tokenId) @context(provider: "vtex.my-cards-graphql@2.x")
}`;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Register a "notify me when back in stock" request.
 * Uses the legacy VTEX .aspx form endpoint (FormData, not JSON).
 */
export async function notifyMe(props: NotifyMeProps): Promise<void> {
	const { account } = getVtexConfig();
	const { email, skuId, name = "" } = props;

	const form = new FormData();
	form.append("notifymeClientName", name);
	form.append("notifymeClientEmail", email);
	form.append("notifymeIdSku", skuId);

	await getVtexFetch()(`https://${account}.vtexcommercestable.com.br/no-cache/AviseMe.aspx`, {
		method: "POST",
		body: form,
		operation: "notifyme",
	});
}

/**
 * Send an Intelligent Search analytics event to sp.vtex.com.
 *
 * @param event     - The typed event payload.
 * @param isCookies - IS session tracking IDs (anonymous + session).
 *                    In the original, these came from getISCookiesFromBag(ctx).
 * @param userAgent - Forwarded user-agent string.
 */
export async function sendEvent(
	event: AnalyticsEvent,
	isCookies: ISCookies,
	userAgent?: string,
): Promise<void> {
	const { account } = getVtexConfig();

	await getVtexFetch()(`https://sp.vtex.com/event-api/v1/${account}/event`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			...event,
			...isCookies,
			agent: userAgent || "deco-sites/apps",
		}),
		operation: "analytics.event",
	});
}

/**
 * Submit a product review via the Reviews & Ratings API.
 * Hits POST https://{account}.myvtex.com/reviews-and-ratings/api/review.
 * Auth is passed via the `VtexIdclientAutCookie` header (not a Cookie header).
 */
export async function submitReview(data: ReviewData, authCookie: string): Promise<unknown> {
	const { account } = getVtexConfig();

	return vtexFetch<unknown>(`https://${account}.myvtex.com/reviews-and-ratings/api/review`, {
		method: "POST",
		body: JSON.stringify(data),
		headers: { [VTEX_AUTH_COOKIE]: authCookie },
	});
}

/**
 * Delete a saved payment token (credit card) for the authenticated user.
 * Uses the my-cards-graphql VTEX IO app.
 */
export async function deletePaymentToken(
	tokenId: string,
	authCookie: string,
): Promise<DeletePaymentTokenResult> {
	return gql<DeletePaymentTokenResult>(DELETE_PAYMENT_TOKEN, { tokenId }, authCookie);
}
