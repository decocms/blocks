import { getWakeClient } from "../../client";
import { CreateProductReview } from "../../utils/graphql/queries";
import type {
  CreateProductReviewMutation,
  Review,
} from "../../utils/graphql/storefront.graphql.gen";
import { forwardedHeaders } from "../../utils/requestCtx";

export interface Props {
  email: string;
  name: string;
  productVariantId: number;
  rating: number;
  review: string;
}

const action = async (props: Props): Promise<Review | null> => {
  const storefront = getWakeClient();
  const headers = forwardedHeaders();

  const data = await storefront.query<CreateProductReviewMutation>(
    CreateProductReview,
    props as unknown as Record<string, unknown>,
    headers,
  );

  return data.createProductReview ?? null;
};

export default action;
