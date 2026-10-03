// upstream-clients.mdx › Write a client (src/search.ts), verbatim.
import { createAcmeSearch } from "./acme-search";

export const search = createAcmeSearch({
  endpoint: process.env.ACME_SEARCH_URL!,
  apiKey: process.env.ACME_SEARCH_KEY!,
});
