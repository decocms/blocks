import { getWakeClient } from "../client";
import { GetProducts } from "./graphql/queries";
import type {
  GetProductsQuery,
  GetProductsQueryVariables,
  ProductFragment,
} from "./graphql/storefront.graphql.gen";
import { toProduct } from "./transform";

export const MAXIMUM_REQUEST_QUANTITY = 50;

/**
 * Fetch every variant for the given product ids (paginating the storefront
 * `products` query) and map them to canonical commerce `Product`s.
 */
export const getVariations = async (
  productIds: number[],
  base: URL,
  extraHeaders?: Record<string, string>,
) => {
  const storefront = getWakeClient();
  const variations: ProductFragment[] = [];

  const fetchData = async (cursor?: string) => {
    const variables: GetProductsQueryVariables = {
      first: MAXIMUM_REQUEST_QUANTITY,
      filters: { productId: productIds },
      sortDirection: "ASC",
      sortKey: "RANDOM",
      after: cursor,
    };

    const data = await storefront.query<GetProductsQuery>(GetProducts, variables, extraHeaders);

    if (data.products?.nodes?.length) {
      variations.push(...data.products.nodes.filter((v): v is ProductFragment => Boolean(v)));
    }

    if (data.products?.pageInfo.hasNextPage && data.products.pageInfo.endCursor) {
      await fetchData(data.products.pageInfo.endCursor);
    }
  };

  await fetchData();

  return variations.map((i) => toProduct(i, { base }));
};
