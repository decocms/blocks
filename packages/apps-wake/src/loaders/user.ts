import type { Person } from "@decocms/apps-commerce/types";
import { getWakeClient } from "../client";
import { handleAuthError } from "../utils/authError";
import authenticate from "../utils/authenticate";
import { GetUser } from "../utils/graphql/queries";
import type { GetUserQuery } from "../utils/graphql/storefront.graphql.gen";
import { forwardedHeaders } from "../utils/requestCtx";

/**
 * @title Wake Integration
 * @description User loader
 */
const userLoader = async (): Promise<Person | null> => {
  const storefront = getWakeClient();
  const headers = forwardedHeaders();

  const customerAccessToken = await authenticate();

  if (!customerAccessToken) return null;

  let data: GetUserQuery | undefined;
  try {
    data = await storefront.query<GetUserQuery>(GetUser, { customerAccessToken }, headers);
  } catch (error: unknown) {
    handleAuthError(error, "load user data");
  }

  const customer = data?.customer;

  if (!customer) return null;

  return {
    "@id": String(customer.id ?? customer.customerId),
    email: customer.email ?? undefined,
    givenName: customer.customerName ?? undefined,
    gender:
      customer.gender === "Masculino"
        ? "https://schema.org/Male"
        : customer.gender === "Feminino"
          ? "https://schema.org/Female"
          : undefined,
  };
};

export default userLoader;

// User-specific response; must not be cached/shared.
export const cache = "no-store";
