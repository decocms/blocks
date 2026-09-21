import { getCheckoutUrl } from "../client";

/**
 * Checkout paths that must be proxied to the Wake checkout host. In the Deno
 * runtime this loader returned deco `Route[]` consumed by the `website` router;
 * that router does not exist in this architecture, so the loader returns a
 * serializable descriptor list that the storefront's worker entry consumes to
 * install its own proxy handler.
 */
const PATHS_TO_PROXY: Array<[string, string?]> = [
  ["/checkout", "/checkout"],
  ["/Fechamento"],
  ["/Fechamento/*"],
  ["/Login"],
  ["/Login/*"],
  ["/login/*"],
  ["/Login/Authenticate"],
  ["/Carrinho/*"],
  ["/api/*"],
  ["/MinhaConta"],
  ["/MinhaConta/*"],
];

export interface Props {
  extraPathsToProxy?: string[];
  /**
   * @title Other site maps to include
   */
  includeSiteMap?: string[];
}

export type WakeProxyRoute =
  | {
      type: "proxy";
      pathTemplate: string;
      basePath?: string;
      /** Target host to proxy to (the Wake checkout URL). */
      url: string;
      /** Host header to forward. */
      host: string;
    }
  | {
      type: "sitemap";
      pathTemplate: string;
      include?: string[];
      host: string;
    };

/**
 * @title Wake Proxy Routes
 */
function loader(props: Props): WakeProxyRoute[] {
  const { includeSiteMap, extraPathsToProxy = [] } = props;

  const checkoutUrl = getCheckoutUrl();

  const extraPathsAsArray: Array<[string, string?]> = extraPathsToProxy.map((path) => [path]);

  const checkout: WakeProxyRoute[] = [...PATHS_TO_PROXY, ...extraPathsAsArray].map(
    ([pathTemplate, basePath]) => ({
      type: "proxy",
      pathTemplate,
      basePath,
      url: checkoutUrl,
      host: checkoutUrl,
    }),
  );

  const sitemap: WakeProxyRoute = {
    type: "sitemap",
    pathTemplate: "/Sitemap.xml",
    include: includeSiteMap,
    host: checkoutUrl,
  };

  return [...checkout, sitemap];
}

export default loader;
