/**
 * VTEX Newsletter actions.
 * Ported from deco-cx/apps:
 *   - vtex/actions/newsletter/subscribe.ts
 *   - vtex/actions/newsletter/updateNewsletterOptIn.ts
 * @see https://developers.vtex.com/docs/guides/newsletter
 */
import { getVtexConfig, getVtexFetch, vtexFetch } from "../client";
import { buildAuthCookieHeader } from "../utils/vtexId";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubscribeProps {
	email: string;
	name?: string;
	page?: string;
	part?: string;
	/** Intentionally preserving the original typo from the VTEX legacy form field. */
	campaing?: string;
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

const SUBSCRIBE_NEWSLETTER = `mutation SubscribeNewsletter($email: String!, $isNewsletterOptIn: Boolean!) {
  subscribeNewsletter(email: $email, isNewsletterOptIn: $isNewsletterOptIn) @context(provider: "vtex.store-graphql@2.x")
}`;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Subscribe to the newsletter via the legacy VTEX .aspx form endpoint.
 * Uses raw fetch because the body is FormData (not JSON).
 */
export async function subscribe(props: SubscribeProps): Promise<void> {
	const { account } = getVtexConfig();
	const {
		email,
		name = "",
		part = "newsletter",
		page = "_",
		campaing = "newsletter:opt-in",
	} = props;

	const form = new FormData();
	form.append("newsletterClientName", name);
	form.append("newsletterClientEmail", email);
	form.append("newsInternalPage", page);
	form.append("newsInternalPart", part);
	form.append("newsInternalCampaign", campaing);

	await getVtexFetch()(`https://${account}.vtexcommercestable.com.br/no-cache/Newsletter.aspx`, {
		method: "POST",
		body: form,
		operation: "newsletter.subscribe",
	});
}

/**
 * Toggle the newsletter opt-in flag for an authenticated user.
 * The original Deco action extracted `email` from the auth cookie payload.
 * Here the caller must provide it explicitly.
 */
export async function updateNewsletterOptIn(
	subscribed: boolean,
	email: string,
	authCookie: string,
): Promise<{ subscribed: boolean }> {
	await gql<unknown>(SUBSCRIBE_NEWSLETTER, { email, isNewsletterOptIn: subscribed }, authCookie);
	return { subscribed };
}
