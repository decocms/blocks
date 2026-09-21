import { getWakeClient } from "../../client";
import { getCartCookie, setCartCookie } from "../../utils/cart";
import { AddItemToCart } from "../../utils/graphql/queries";
import type {
  AddItemToCartMutation,
  CheckoutFragment,
} from "../../utils/graphql/storefront.graphql.gen";
import { HttpError } from "../../utils/httpError";
import {
  currentRequestHeaders,
  currentResponseHeaders,
  forwardedHeaders,
} from "../../utils/requestCtx";

export interface CartItem {
  productVariantId: number;
  quantity: number;
  customization?: { customizationId: number; value: string }[];
  subscription?: { subscriptionGroupId: number; recurringTypeId: number };
}

export interface Props {
  products: CartItem[];
}

const action = async (props: Props): Promise<Partial<CheckoutFragment>> => {
  const storefront = getWakeClient();
  const cartId = getCartCookie(currentRequestHeaders());
  const headers = forwardedHeaders();

  if (!cartId) {
    throw new HttpError(400, "Missing cart cookie");
  }

  const data = await storefront.query<AddItemToCartMutation>(
    AddItemToCart,
    { input: { id: cartId, products: props.products } },
    headers,
  );

  const checkoutId = data.checkout?.checkoutId;

  if (checkoutId && cartId !== checkoutId) {
    setCartCookie(currentResponseHeaders(), checkoutId);
  }

  return data.checkout ?? {};
};

export default action;
