import type { Product, ProductDetailsPage } from "@decocms/apps-commerce/types";
import { getWakeClient } from "../client";
import { handleAuthError } from "../utils/authError";
import { MAXIMUM_REQUEST_QUANTITY } from "../utils/getVariations";
import { GetBuyList, GetProduct } from "../utils/graphql/queries";
import type { BuyListQuery, GetProductQuery } from "../utils/graphql/storefront.graphql.gen";
import { getPartnerCookie } from "../utils/partner";
import { currentRequestHeaders, currentUrl, forwardedHeaders } from "../utils/requestCtx";
import { parseSlug, toBreadcrumbList, toProduct } from "../utils/transform";
import type { RequestURLParam } from "../utils/types";
import productListLoader from "./productList";

export interface Props {
  slug: RequestURLParam;
  buyTogether?: boolean;
  includeSameParent?: boolean;
}

/**
 * @title Wake Integration
 * @description Product Details Page loader
 */
async function loader(props: Props): Promise<ProductDetailsPage | null> {
  const url = currentUrl();
  const { slug, buyTogether, includeSameParent } = props;
  const storefront = getWakeClient();

  const partnerAccessToken = getPartnerCookie(currentRequestHeaders());

  const headers = forwardedHeaders();

  if (!slug) return null;

  const variantId = Number(url.searchParams.get("skuId")) || null;
  const { id: productId } = parseSlug(slug);

  if (!productId) {
    throw new Error("Missing product id");
  }

  let wakeBuyList: BuyListQuery["buyList"] | undefined;
  try {
    const buyListResult = await storefront.query<BuyListQuery>(
      GetBuyList,
      { id: productId, partnerAccessToken },
      headers,
    );
    wakeBuyList = buyListResult.buyList;
  } catch (error: unknown) {
    handleAuthError(error, "load buy list");
  }

  const buyListProducts = await Promise.all(
    wakeBuyList?.buyListProducts?.map(async (buyListProduct) => {
      if (!buyListProduct) return;

      const { productId, includeSameParent, quantity } = buyListProduct;

      const buyListProductPage = await loader({
        // 'slug' its just to fit the parse function of loader
        slug: `slug-${productId}`,
        includeSameParent,
      });

      if (!buyListProductPage) return;

      buyListProductPage.product.additionalProperty?.push({
        "@type": "PropertyValue",
        name: "SuggestedQuantity",
        value: String(quantity),
        alternateName: "Buy List Suggested Quantity",
      });

      return buyListProductPage.product;
    }) ?? [],
  ).then((maybeProductList) => maybeProductList.filter((node): node is Product => Boolean(node)));

  let wakeProduct: GetProductQuery["product"] | undefined;
  try {
    const productResult = await storefront.query<GetProductQuery>(
      GetProduct,
      {
        productId,
        includeParentIdVariants: includeSameParent,
        partnerAccessToken,
      },
      headers,
    );
    wakeProduct = productResult.product;
  } catch (error: unknown) {
    handleAuthError(error, "load product details");
  }

  const wakeProductOrBuyList = wakeProduct || wakeBuyList;

  if (!wakeProductOrBuyList) {
    return null;
  }

  const variantsItems =
    (await productListLoader({
      first: MAXIMUM_REQUEST_QUANTITY,
      sortDirection: "ASC",
      sortKey: "RANDOM",
      filters: { productId: [productId] },
    })) ?? [];

  const buyTogetherItens =
    buyTogether && wakeProductOrBuyList.buyTogether?.length
      ? ((await productListLoader({
          first: MAXIMUM_REQUEST_QUANTITY,
          sortDirection: "ASC",
          sortKey: "RANDOM",
          filters: {
            productId: wakeProductOrBuyList.buyTogether
              ?.map((bt) => bt?.productId)
              .filter((id): id is number => id != null),
            mainVariant: true,
          },
          getVariations: true,
        })) ?? [])
      : [];

  const product = toProduct(wakeProductOrBuyList, { base: url }, variantsItems, variantId);
  return {
    "@type": "ProductDetailsPage",
    breadcrumbList: toBreadcrumbList(
      wakeProductOrBuyList.breadcrumbs ?? [],
      {
        base: url,
      },
      product,
    ),
    product: {
      ...product,
      isAccessoryOrSparePartFor: buyListProducts,
      isRelatedTo:
        buyTogetherItens?.map((buyItem) => {
          return {
            ...buyItem,
            additionalType: "BuyTogether",
          };
        }) ?? [],
    },
    seo: {
      canonical: product.isVariantOf?.url ?? "",
      title: wakeProductOrBuyList.productName ?? "",
      description: wakeProductOrBuyList.seo?.find((m) => m?.name === "description")?.content ?? "",
    },
  };
}

export const cache = "stale-while-revalidate";

export const cacheKey = (props: Props): string | null => {
  const url = currentUrl();
  const skuId = url.searchParams.get("skuId") ?? "";

  // Avoid cross-tenant cache bleed when a partner token is present
  if (getPartnerCookie(currentRequestHeaders())) {
    return null;
  }

  const params = new URLSearchParams([
    ["slug", String(props.slug)],
    ["buyTogether", String(props.buyTogether ?? false)],
    ["includeSameParent", String(props.includeSameParent ?? false)],
    ["skuId", skuId],
  ]);

  return `wake:pdp?${params.toString()}`;
};

export default loader;
