import { getWakeClient } from "../client";
import { ProductRestockAlert } from "../utils/graphql/queries";
import type {
  ProductRestockAlertMutation,
  RestockAlertNode,
} from "../utils/graphql/storefront.graphql.gen";
import { forwardedHeaders } from "../utils/requestCtx";

export interface Props {
  email: string;
  name: string;
  productVariantId: number;
}

const action = async (props: Props): Promise<RestockAlertNode | null> => {
  const storefront = getWakeClient();
  const headers = forwardedHeaders();

  const data = await storefront.query<ProductRestockAlertMutation>(
    ProductRestockAlert,
    { input: props },
    headers,
  );

  return data.productRestockAlert ?? null;
};

export default action;
