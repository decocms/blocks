import type { Product } from "@decocms/apps-commerce/types";
import { getWakeClient } from "../client";
import { handleAuthError } from "../utils/authError";
import { getVariations } from "../utils/getVariations";
import { ProductRecommendations } from "../utils/graphql/queries";
import type {
  ProductFragment,
  ProductRecommendationsQuery,
} from "../utils/graphql/storefront.graphql.gen";
import { getPartnerCookie } from "../utils/partner";
import { currentRequestHeaders, currentUrl, forwardedHeaders } from "../utils/requestCtx";
import { parseSlug, toProduct } from "../utils/transform";
import type { RequestURLParam } from "../utils/types";

export interface Props {
  /**
   * @default DEFAULT
   * @description Algorithm type
   */
  algorithm: "DEFAULT";
  quantity: number;
  slug: RequestURLParam;
  /** @description Retrieve variantions for each product. */
  getVariations?: boolean;
}

/**
 * @title Wake Integration - Product Recommendations
 * @description Product Recommendations loader
 */
const productRecommendationsLoader = async (props: Props): Promise<Product[] | null> => {
  const url = currentUrl();
  const storefront = getWakeClient();
  const { slug, quantity, algorithm = "DEFAULT" } = props;
  const partnerAccessToken = getPartnerCookie(currentRequestHeaders());

  const headers = forwardedHeaders();

  const { id: productId } = parseSlug(slug);

  let data: ProductRecommendationsQuery | undefined;
  try {
    data = await storefront.query<ProductRecommendationsQuery>(
      ProductRecommendations,
      { quantity, productId, algorithm, partnerAccessToken },
      headers,
    );
  } catch (error: unknown) {
    handleAuthError(error, "load product recommendations");
  }

  const products = data?.productRecommendations;

  if (!Array.isArray(products)) {
    return null;
  }

  const productIDs = products.map((i) => i?.productId).filter((id): id is number => id != null);

  const variations = props.getVariations ? await getVariations(productIDs, url, headers) : [];

  return products
    ?.filter((p): p is ProductFragment => Boolean(p))
    .map((variant) => {
      const productVariations = variations?.filter(
        (v) => v.inProductGroupWithID === variant.productId,
      );

      return toProduct(variant, { base: url }, productVariations);
    });
};

export const cache = "stale-while-revalidate";

export const cacheKey = (props: Props): string | null => {
  // Avoid cross-tenant cache bleed when a partner token is present
  if (getPartnerCookie(currentRequestHeaders())) {
    return null;
  }

  return `wake:recommendations:${props.slug}:${props.quantity}:${props.algorithm}:${props.getVariations ?? false}`;
};

export default productRecommendationsLoader;
