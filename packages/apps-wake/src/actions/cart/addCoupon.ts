import { getWakeClient } from "../../client";
import { getCartCookie, setCartCookie } from "../../utils/cart";
import { AddCoupon } from "../../utils/graphql/queries";
import type {
  AddCouponMutation,
  CheckoutFragment,
} from "../../utils/graphql/storefront.graphql.gen";
import { HttpError } from "../../utils/httpError";
import {
  currentRequestHeaders,
  currentResponseHeaders,
  forwardedHeaders,
} from "../../utils/requestCtx";

export interface Props {
  coupon: string;
}

const action = async (props: Props): Promise<Partial<CheckoutFragment>> => {
  const storefront = getWakeClient();
  const cartId = getCartCookie(currentRequestHeaders());
  const headers = forwardedHeaders();

  if (!cartId) {
    throw new HttpError(400, "Missing cart cookie");
  }

  const data = await storefront.query<AddCouponMutation>(
    AddCoupon,
    { checkoutId: cartId, ...props },
    headers,
  );

  const checkoutId = data.checkout?.checkoutId;

  if (checkoutId && cartId !== checkoutId) {
    setCartCookie(currentResponseHeaders(), checkoutId);
  }

  return data.checkout ?? {};
};

export default action;
