import { getWakeClient } from "../../client";
import { getCartCookie, setCartCookie } from "../../utils/cart";
import { CheckoutPartnerAssociate } from "../../utils/graphql/queries";
import type {
  CheckoutFragment,
  CheckoutPartnerAssociateMutation,
} from "../../utils/graphql/storefront.graphql.gen";
import { HttpError } from "../../utils/httpError";
import { setPartnerCookie } from "../../utils/partner";
import {
  currentRequestHeaders,
  currentResponseHeaders,
  forwardedHeaders,
} from "../../utils/requestCtx";

export interface Props {
  partnerAccessToken: string;
}

const action = async (props: Props): Promise<Partial<CheckoutFragment>> => {
  const storefront = getWakeClient();
  const cartId = getCartCookie(currentRequestHeaders());
  const headers = forwardedHeaders();
  const { partnerAccessToken } = props;

  if (!cartId) {
    throw new HttpError(400, "Missing cart cookie");
  }

  const data = await storefront.query<CheckoutPartnerAssociateMutation>(
    CheckoutPartnerAssociate,
    { checkoutId: cartId, partnerAccessToken },
    headers,
  );

  const checkoutId = data.checkout?.checkoutId;
  const responseHeaders = currentResponseHeaders();

  if (checkoutId && cartId !== checkoutId) {
    setCartCookie(responseHeaders, checkoutId);
  }

  setPartnerCookie(responseHeaders, partnerAccessToken);

  return data.checkout ?? {};
};

export default action;
