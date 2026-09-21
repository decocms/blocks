import { getWakeClient } from "../client";
import { handleAuthError } from "../utils/authError";
import { GetPartners } from "../utils/graphql/queries";
import type { GetPartnersQuery } from "../utils/graphql/storefront.graphql.gen";
import { getPartnerCookie } from "../utils/partner";
import { currentRequestHeaders, forwardedHeaders } from "../utils/requestCtx";
import type { RequestURLParam } from "../utils/types";

export interface Props {
  slug: RequestURLParam;
}

/**
 * @title Wake Integration - Partners
 * @description Partners loader
 */
const loader = async (props: Props): Promise<GetPartnersQuery["partners"]> => {
  const storefront = getWakeClient();
  const { slug } = props;

  const headers = forwardedHeaders();

  // Guard against missing slug to prevent querying with [undefined]
  if (!slug) {
    return undefined;
  }

  let data: GetPartnersQuery | undefined;
  try {
    data = await storefront.query<GetPartnersQuery>(
      GetPartners,
      { first: 1, alias: [slug] },
      headers,
    );
  } catch (error: unknown) {
    handleAuthError(error, "load partner information");
  }

  return data?.partners ?? undefined;
};

export const cache = "stale-while-revalidate";

export const cacheKey = (props: Props): string | null => {
  // Don't cache if no slug is provided
  if (!props.slug) {
    return null;
  }

  // Don't cache if partner cookie is present - partner-specific content should not be cached
  if (getPartnerCookie(currentRequestHeaders())) {
    return null;
  }

  return `wake:partners:${props.slug}:1`;
};

export default loader;
