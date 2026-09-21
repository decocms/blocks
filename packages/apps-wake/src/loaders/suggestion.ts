import type { Suggestion } from "@decocms/apps-commerce/types";
import { getWakeClient } from "../client";
import { handleAuthError } from "../utils/authError";
import { Autocomplete } from "../utils/graphql/queries";
import type { AutocompleteQuery, ProductFragment } from "../utils/graphql/storefront.graphql.gen";
import { getPartnerCookie } from "../utils/partner";
import { currentRequestHeaders, currentUrl, forwardedHeaders } from "../utils/requestCtx";
import { toProduct } from "../utils/transform";

export interface Props {
  query: string;
  limit?: number;
}

/**
 * @title Wake Integration
 * @description Product Suggestion loader
 */
const loader = async (props: Props): Promise<Suggestion | null> => {
  const storefront = getWakeClient();
  const { query, limit = 10 } = props;

  const partnerAccessToken = getPartnerCookie(currentRequestHeaders());
  const headers = forwardedHeaders();
  const url = currentUrl();

  if (!query) return null;

  let data: AutocompleteQuery | undefined;
  try {
    data = await storefront.query<AutocompleteQuery>(
      Autocomplete,
      { query, limit, partnerAccessToken },
      headers,
    );
  } catch (error: unknown) {
    handleAuthError(error, "load product suggestions");
  }

  const { products: wakeProducts, suggestions = [] } = data?.autocomplete ?? {};

  if (!wakeProducts?.length && !suggestions?.length) return null;

  const products = wakeProducts
    ?.filter((node): node is ProductFragment => Boolean(node))
    .map((node) => toProduct(node, { base: url }));

  return {
    products: products,
    searches: suggestions?.filter(Boolean)?.map((suggestion) => ({
      term: suggestion!,
    })),
  };
};

export const cache = "no-cache";

export const cacheKey = (props: Props): string | null => {
  // Avoid cross-tenant cache bleed when a partner token is present
  if (getPartnerCookie(currentRequestHeaders())) {
    return null;
  }

  return `wake:suggestion:${props.query}:${props.limit ?? 10}`;
};

export default loader;
