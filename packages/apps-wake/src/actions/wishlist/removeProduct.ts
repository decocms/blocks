import { getWakeClient } from "../../client";
import authenticate from "../../utils/authenticate";
import { WishlistRemoveProduct } from "../../utils/graphql/queries";
import type {
  ProductFragment,
  WishlistReducedProductFragment,
  WishlistRemoveProductMutation,
} from "../../utils/graphql/storefront.graphql.gen";
import { forwardedHeaders } from "../../utils/requestCtx";

export interface Props {
  productId: number;
}

const action = async (props: Props): Promise<WishlistReducedProductFragment[] | null> => {
  const storefront = getWakeClient();
  const { productId } = props;

  const headers = forwardedHeaders();

  const customerAccessToken = await authenticate();

  if (!customerAccessToken) return [];

  const data = await storefront.query<WishlistRemoveProductMutation>(
    WishlistRemoveProduct,
    { customerAccessToken, productId },
    headers,
  );

  const products = data.wishlistRemoveProduct;

  if (!Array.isArray(products)) {
    return null;
  }

  return products
    .filter((node): node is ProductFragment => Boolean(node))
    .map(({ productId, productName }) => ({
      productId,
      productName,
    }));
};

export default action;
