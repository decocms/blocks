import { getWakeClient } from "../../client";
import { getCartCookie, setCartCookie } from "../../utils/cart";
import { AddKit } from "../../utils/graphql/queries";
import type { AddKitMutation, CheckoutFragment } from "../../utils/graphql/storefront.graphql.gen";
import { HttpError } from "../../utils/httpError";
import {
  currentRequestHeaders,
  currentResponseHeaders,
  forwardedHeaders,
} from "../../utils/requestCtx";

export interface KitItemVariant {
  productVariantId: number;
  quantity: number;
}

export interface KitItem {
  productId: number;
  variants: KitItemVariant[];
}

export interface Props {
  products: KitItem[];
  quantity: number;
  kitId: number;
}

const action = async (props: Props): Promise<Partial<CheckoutFragment>> => {
  const storefront = getWakeClient();
  const cartId = getCartCookie(currentRequestHeaders());
  const headers = forwardedHeaders();
  const { quantity, kitId, products } = props;

  if (!cartId) {
    throw new HttpError(400, "Missing cart cookie");
  }

  const data = await storefront.query<AddKitMutation>(
    AddKit,
    { input: { id: cartId, quantity, kitId, products } },
    headers,
  );

  const checkoutId = data.checkout?.checkoutId;

  if (checkoutId && cartId !== checkoutId) {
    setCartCookie(currentResponseHeaders(), checkoutId);
  }

  return data.checkout ?? {};
};

export default action;
