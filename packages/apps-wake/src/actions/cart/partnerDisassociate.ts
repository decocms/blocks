import { getWakeClient } from "../../client";
import { getCartCookie, setCartCookie } from "../../utils/cart";
import { CheckoutPartnerDisassociate } from "../../utils/graphql/queries";
import type {
  CheckoutFragment,
  CheckoutPartnerDisassociateMutation,
} from "../../utils/graphql/storefront.graphql.gen";
import { HttpError } from "../../utils/httpError";
import { deletePartnerCookie } from "../../utils/partner";
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

  const data = await storefront.query<CheckoutPartnerDisassociateMutation>(
    CheckoutPartnerDisassociate,
    { checkoutId: cartId },
    headers,
  );

  const checkoutId = data.checkout?.checkoutId;
  const responseHeaders = currentResponseHeaders();

  if (checkoutId && cartId !== checkoutId) {
    setCartCookie(responseHeaders, checkoutId);
  }

  deletePartnerCookie(responseHeaders);

  return data.checkout ?? {};
};

export default action;
