import { getWakeClient } from "../../client";
import cartLoader from "../../loaders/cart";
import { getCartCookie, setCartCookie } from "../../utils/cart";
import { RemoveItemFromCart } from "../../utils/graphql/queries";
import type {
  CheckoutFragment,
  RemoveItemFromCartMutation,
} from "../../utils/graphql/storefront.graphql.gen";
import { HttpError } from "../../utils/httpError";
import {
  currentRequestHeaders,
  currentResponseHeaders,
  forwardedHeaders,
} from "../../utils/requestCtx";
import addItem from "./addItem";

export interface Props {
  productVariantId: number;
  quantity: number;
  customization?: { customizationId: number; value: string }[];
  subscription?: { subscriptionGroupId: number; recurringTypeId: number };
}

const removeFromCart = (props: Props, cartId: string, headers: Record<string, string>) =>
  getWakeClient().query<RemoveItemFromCartMutation>(
    RemoveItemFromCart,
    { input: { id: cartId, products: [props] } },
    headers,
  );

const action = async (props: Props): Promise<Partial<CheckoutFragment>> => {
  const cartId = getCartCookie(currentRequestHeaders());
  const headers = forwardedHeaders();

  if (!cartId) {
    throw new HttpError(400, "Missing cart cookie");
  }

  /*
   * get cart
   * find the current product on cart
   * the current amount
   * calculate the difference between the current item amount and requested new amount
   */

  const cart = await cartLoader();
  const item = cart.products?.find((item) => item?.productVariantId === props.productVariantId);
  const quantityItem = item?.quantity ?? 0;
  const quantity = props.quantity - quantityItem;

  let checkout: Partial<CheckoutFragment> | undefined;

  if (props.quantity > 0 && quantity > 0) {
    checkout = await addItem({ ...props, quantity });
  } else {
    const data = await removeFromCart({ ...props, quantity: -quantity }, cartId, headers);
    checkout = data.checkout ?? undefined;
  }

  const checkoutId = checkout?.checkoutId;

  if (checkoutId && cartId !== checkoutId) {
    setCartCookie(currentResponseHeaders(), checkoutId);
  }

  return checkout ?? {};
};

export default action;
