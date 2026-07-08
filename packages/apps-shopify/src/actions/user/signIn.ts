import { getShopifyClient } from "../../client";
import { SignInWithEmailAndPassword } from "../../utils/storefront/queries";
import { getUserCookie, setUserCookie } from "../../utils/user";

export interface SignInProps {
	email: string;
	password: string;
	requestHeaders: Headers;
	responseHeaders?: Headers;
}

export interface SignInResult {
	customerAccessTokenCreate: {
		customerAccessToken?: { accessToken: string; expiresAt: string } | null;
		customerUserErrors?: Array<{ code?: string; message: string }>;
	};
}

export default async function signIn(props: SignInProps): Promise<SignInResult | null> {
	const client = getShopifyClient();
	const { email, password, requestHeaders, responseHeaders } = props;

	const existingToken = getUserCookie(requestHeaders);
	if (existingToken) return null;

	try {
		const data = await client.query<SignInResult>(SignInWithEmailAndPassword, { email, password });

		if (data.customerAccessTokenCreate.customerAccessToken && responseHeaders) {
			setUserCookie(
				responseHeaders,
				data.customerAccessTokenCreate.customerAccessToken.accessToken,
			);
		}

		return data;
	} catch {
		return null;
	}
}
