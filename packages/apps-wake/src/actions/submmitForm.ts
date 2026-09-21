import { getWakeClient } from "../client";
import { SendGenericForm } from "../utils/graphql/queries";
import type { SendGenericFormMutation } from "../utils/graphql/storefront.graphql.gen";
import { forwardedHeaders } from "../utils/requestCtx";

export interface Props {
  body: unknown;
  // file: Upload,
  recaptchaToken: string;
}

const action = async (props: Props): Promise<SendGenericFormMutation["sendGenericForm"]> => {
  const storefront = getWakeClient();
  const headers = forwardedHeaders();

  const data = await storefront.query<SendGenericFormMutation>(
    SendGenericForm,
    props as unknown as Record<string, unknown>,
    headers,
  );

  return data.sendGenericForm!;
};

export default action;
