import { getWakeClient } from "../client";
import { handleAuthError } from "../utils/authError";
import { Shop } from "../utils/graphql/queries";
import type { ShopQuery } from "../utils/graphql/storefront.graphql.gen";
import { getPartnerCookie } from "../utils/partner";
import { currentRequestHeaders, forwardedHeaders } from "../utils/requestCtx";

/**
 * @title Wake Integration - Shop Infos
 * @description Shop Infos loader
 */
const shopInfos = async (): Promise<ShopQuery["shop"] | undefined> => {
  const storefront = getWakeClient();
  const headers = forwardedHeaders();

  let data: ShopQuery;
  try {
    data = await storefront.query<ShopQuery>(Shop, {}, headers);
  } catch (error: unknown) {
    handleAuthError(error, "load shop information");
  }

  return data?.shop ?? undefined;
};

export const cache = "stale-while-revalidate";

export const cacheKey = (): string | null => {
  // Avoid cross-tenant cache bleed when a partner token is present
  if (getPartnerCookie(currentRequestHeaders())) {
    return null;
  }

  return "wake:shop";
};

export default shopInfos;
