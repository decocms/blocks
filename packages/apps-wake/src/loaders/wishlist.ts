import { getWakeClient } from "../client";
import { handleAuthError } from "../utils/authError";
import authenticate from "../utils/authenticate";
import { GetWishlist } from "../utils/graphql/queries";
import type {
  GetWishlistQuery,
  WishlistReducedProductFragment,
} from "../utils/graphql/storefront.graphql.gen";
import { forwardedHeaders } from "../utils/requestCtx";

/**
 * @title Wake Integration
 * @description Product Wishlist loader
 */
const loader = async (): Promise<WishlistReducedProductFragment[]> => {
  const storefront = getWakeClient();
  const headers = forwardedHeaders();

  const customerAccessToken = await authenticate();

  if (!customerAccessToken) return [];

  let data: GetWishlistQuery | undefined;
  try {
    data = await storefront.query<GetWishlistQuery>(GetWishlist, { customerAccessToken }, headers);
  } catch (error: unknown) {
    handleAuthError(error, "load wishlist");
  }

  return (
    data?.customer?.wishlist?.products?.filter((p): p is WishlistReducedProductFragment =>
      Boolean(p),
    ) ?? []
  );
};

export default loader;

// User-specific wishlist data; must not be cached/shared.
export const cache = "no-store";
