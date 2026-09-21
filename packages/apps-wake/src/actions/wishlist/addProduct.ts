import { getWakeClient } from "../../client";
import authenticate from "../../utils/authenticate";
import { WishlistAddProduct } from "../../utils/graphql/queries";
import type {
  ProductFragment,
  WishlistAddProductMutation,
  WishlistReducedProductFragment,
} from "../../utils/graphql/storefront.graphql.gen";
import { forwardedHeaders } from "../../utils/requestCtx";

export interface Props {
  productId: number;
}

const action = async (props: Props): Promise<WishlistReducedProductFragment[] | null> => {
  const storefront = getWakeClient();
  const { productId } = props;
  const customerAccessToken = await authenticate();
  const headers = forwardedHeaders();

  if (!customerAccessToken) return [];

  const data = await storefront.query<WishlistAddProductMutation>(
    WishlistAddProduct,
    { customerAccessToken, productId },
    headers,
  );

  const products = data.wishlistAddProduct;

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
