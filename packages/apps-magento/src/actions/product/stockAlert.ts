/**
 * Magento product stock-alert subscribe — fires a GraphQL mutation so
 * the customer gets notified when an out-of-stock SKU is replenished.
 *
 * Verbatim port of `deco-cx/apps/magento/actions/product/stockAlert.ts`.
 * The Fresh version called `ctx.clientGraphql.query(...)` with a third
 * `STALE` parameter that opted into a 1h SWR cache. The TanStack/Node
 * port uses `magentoFetch` against `/graphql` directly; STALE was a
 * cache hint only — the mutation is a write so no caching applies and
 * we can drop the parameter (the original passed it but mutations are
 * never cached server-side, so the behavior is identical).
 *
 * Response shape preserved: returns `{ data: { productStockAlert } }`
 * on success or `{ error: string }` on failure.
 */
import { getMagentoConfig, magentoFetch } from "../../client";
import type { ProductStockAlertResponse } from "../../types";

export interface StockAlertProps {
	product_id: number;
	name: string;
	email: string;
}

const MUTATION = `mutation ProductStockAlert($product_id: Int!, $name: String!, $email: String!) {
  productStockAlert(
    product_id: $product_id
    name: $name
    email: $email
  ) {
    message
    status
  }
}`;

export default async function stockAlert(
	props: StockAlertProps,
): Promise<ProductStockAlertResponse | { error: string }> {
	const { product_id, name, email } = props;
	const { baseUrl } = getMagentoConfig();

	try {
		const res = await magentoFetch(`${baseUrl.replace(/\/$/, "")}/graphql`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				operationName: "ProductStockAlert",
				variables: { product_id, name, email },
				query: MUTATION,
			}),
		});

		const json = (await res.json()) as {
			data?: { productStockAlert: { message: string; status: boolean } };
		};

		if (!json.data?.productStockAlert) {
			return { error: "productStockAlert payload missing in GraphQL response" };
		}

		return { data: { productStockAlert: json.data.productStockAlert } };
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : "Erro desconhecido",
		};
	}
}
