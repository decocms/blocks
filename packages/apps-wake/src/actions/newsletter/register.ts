import { getWakeClient } from "../../client";
import { CreateNewsletterRegister } from "../../utils/graphql/queries";
import type {
  CreateNewsletterRegisterMutation,
  NewsletterNode,
} from "../../utils/graphql/storefront.graphql.gen";
import { HttpError } from "../../utils/httpError";
import { forwardedHeaders } from "../../utils/requestCtx";

export interface Props {
  email: string;
  name: string;
}

const action = async (props: Props): Promise<NewsletterNode> => {
  const storefront = getWakeClient();
  const headers = forwardedHeaders();

  const data = await storefront.query<CreateNewsletterRegisterMutation>(
    CreateNewsletterRegister,
    { input: { ...props } },
    headers,
  );

  if (!data.createNewsletterRegister) {
    throw new HttpError(400, "Error on Register");
  }

  return data.createNewsletterRegister;
};

export default action;
