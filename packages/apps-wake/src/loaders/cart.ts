import { getWakeClient } from "../client";
import { handleAuthError } from "../utils/authError";
import { getCartCookie, setCartCookie } from "../utils/cart";
import { CreateCart, GetCart } from "../utils/graphql/queries";
import type {
  CheckoutFragment,
  CreateCartMutation,
  GetCartQuery,
} from "../utils/graphql/storefront.graphql.gen";
import {
  currentRequestHeaders,
  currentResponseHeaders,
  forwardedHeaders,
} from "../utils/requestCtx";

/**
 * @title Wake Integration
 * @description Cart loader
 */
const loader = async (): Promise<Partial<CheckoutFragment>> => {
  const storefront = getWakeClient();
  const cartId = getCartCookie(currentRequestHeaders());
  const headers = forwardedHeaders();

  let data: GetCartQuery | CreateCartMutation;
  try {
    data = cartId
      ? await storefront.query<GetCartQuery>(GetCart, { checkoutId: cartId }, headers)
      : await storefront.query<CreateCartMutation>(CreateCart, {}, headers);
  } catch (error: unknown) {
    handleAuthError(error, "load cart");
  }

  const checkoutId = data.checkout?.checkoutId;

  if (checkoutId && cartId !== checkoutId) {
    setCartCookie(currentResponseHeaders(), checkoutId);
  }

  return data.checkout ?? {};
};

export default loader;

// User-specific cart data; must not be cached/shared.
export const cache = "no-store";
