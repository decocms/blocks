import { getWakeClient } from "../client";
import { getCartCookie } from "../utils/cart";
import { ShippingQuotes } from "../utils/graphql/queries";
import type {
  ShippingQuotesQuery,
  ShippingQuotesQueryVariables,
} from "../utils/graphql/storefront.graphql.gen";
import { HttpError } from "../utils/httpError";
import { currentRequestHeaders, forwardedHeaders } from "../utils/requestCtx";

export interface Props {
  cep?: string;
  simulateCartItems?: boolean;
  productVariantId?: number;
  quantity?: number;
  useSelectedAddress?: boolean;
}

const buildSimulationParams = (props: Props, checkoutId?: string): ShippingQuotesQueryVariables => {
  const { cep, simulateCartItems, productVariantId, quantity, useSelectedAddress } = props;

  const defaultQueryParams = {
    cep,
    useSelectedAddress,
  };

  if (simulateCartItems) {
    if (!checkoutId) throw new HttpError(400, "Missing cart cookie");

    return {
      ...defaultQueryParams,
      checkoutId,
    };
  }

  return {
    ...defaultQueryParams,
    productVariantId,
    quantity,
  };
};

const action = async (props: Props): Promise<ShippingQuotesQuery["shippingQuotes"]> => {
  const storefront = getWakeClient();
  const headers = forwardedHeaders();

  const cartId = getCartCookie(currentRequestHeaders());

  const simulationParams = buildSimulationParams(props, cartId);

  const data = await storefront.query<ShippingQuotesQuery>(
    ShippingQuotes,
    { ...simulationParams },
    headers,
  );

  return data.shippingQuotes ?? [];
};

export default action;
