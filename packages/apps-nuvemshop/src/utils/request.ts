/** Page props injected by the CMS resolver (`resolve.ts`) into commerce loaders. */
export interface PageProps {
  /** @ignore */
  __pageUrl?: string;
  /** @ignore */
  __pagePath?: string;
}

/** The storefront URL being rendered: CMS-injected page URL, else the invoke request. */
export const pageUrlOf = (props: PageProps, req?: Request) =>
  new URL(props.__pageUrl ?? req?.url ?? "https://localhost/", "https://localhost");

/** Absolute origin for product URLs; empty (relative URLs) when unknown. */
export const originOf = (props: PageProps, req?: Request) => {
  const url = pageUrlOf(props, req);
  return url.hostname === "localhost" && !props.__pageUrl && !req ? "" : url.origin;
};
