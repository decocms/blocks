import { getShopifyClient } from "../client";
import { FetchCustomerInfo } from "../utils/storefront/queries";
import { getUserCookie } from "../utils/user";

export interface ShopifyUser {
	"@id": string;
	email: string;
	givenName: string;
	familyName: string;
}

export default async function userLoader(requestHeaders: Headers): Promise<ShopifyUser | null> {
	const client = getShopifyClient();
	const customerAccessToken = getUserCookie(requestHeaders);

	if (!customerAccessToken) return null;

	try {
		const data = await client.query<{
			customer?: {
				id: string;
				email?: string | null;
				firstName?: string | null;
				lastName?: string | null;
			};
		}>(FetchCustomerInfo, { customerAccessToken });

		if (!data.customer) return null;

		return {
			"@id": data.customer.id,
			email: data.customer.email ?? "",
			givenName: data.customer.firstName ?? "",
			familyName: data.customer.lastName ?? "",
		};
	} catch {
		return null;
	}
}
