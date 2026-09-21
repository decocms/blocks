import type { CheckoutFragment } from "../../utils/graphql/storefront.graphql.gen";
import addItems, { type CartItem as Props } from "./addItems";

export type { CartItem as Props } from "./addItems";

const action = async (props: Props): Promise<Partial<CheckoutFragment>> => {
  return await addItems({ products: [props] });
};

export default action;
