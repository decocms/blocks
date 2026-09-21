import { getWakeClient } from "../../client";
import { getCartCookie, setCartCookie } from "../../utils/cart";
import { RemoveCoupon } from "../../utils/graphql/queries";
import type {
  CheckoutFragment,
  RemoveCouponMutation,
} from "../../utils/graphql/storefront.graphql.gen";
import { HttpError } from "../../utils/httpError";
import {
  currentRequestHeaders,
  currentResponseHeaders,
  forwardedHeaders,
} from "../../utils/requestCtx";

const action = async (): Promise<Partial<CheckoutFragment>> => {
  const storefront = getWakeClient();
  const cartId = getCartCookie(currentRequestHeaders());
  const headers = forwardedHeaders();

  if (!cartId) {
    throw new HttpError(400, "Missing cart cookie");
  }

  const data = await storefront.query<RemoveCouponMutation>(
    RemoveCoupon,
    { checkoutId: cartId },
    headers,
  );

  const checkoutId = data.checkout?.checkoutId;

  if (checkoutId && cartId !== checkoutId) {
    setCartCookie(currentResponseHeaders(), checkoutId);
  }

  return data.checkout ?? {};
};

export default action;
