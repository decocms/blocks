// App contract

// Cart actions
export { default as addItem } from "./actions/cart/addItem";
export { type CartItem, default as addItems } from "./actions/cart/addItems";
export { default as updateItemQuantity } from "./actions/cart/updateItemQuantity";
// Client & Config
export type { WakeConfig } from "./client";
export {
  configureWake,
  getBaseUrl,
  getCheckoutUrl,
  getWakeClient,
  getWakeConfig,
  initWakeFromBlocks,
  setWakeFetch,
} from "./client";
// Cart / user / wishlist
export { default as cartLoader } from "./loaders/cart";
// Shop / partners
export { default as partnersLoader } from "./loaders/partners";
// Product loaders
export { default as productDetailsPageLoader } from "./loaders/productDetailsPage";
export { default as productListLoader } from "./loaders/productList";
export { default as productListingPageLoader } from "./loaders/productListingPage";
export type { WakeProxyRoute } from "./loaders/proxy";
export { default as proxyLoader } from "./loaders/proxy";
export { default as recommendationsLoader } from "./loaders/recommendations";
export { default as shopLoader } from "./loaders/shop";
export { default as suggestionLoader } from "./loaders/suggestion";
export { default as userLoader } from "./loaders/user";
export { default as wishlistLoader } from "./loaders/wishlist";
export { configure, type Props, type WakeState } from "./mod";
// Registry
export { WAKE_REGISTRY_ENTRY } from "./registry";

// Cookie utils
export { getCartCookie, setCartCookie, setClientCookie } from "./utils/cart";
export { getCookies, setCookie } from "./utils/cookies";
// GraphQL client + fetch instrumentation
export { extractGraphqlOperationName } from "./utils/graphqlOperationName";
export { type CreateWakeFetchOptions, createWakeFetch } from "./utils/instrumentedFetch";
export { wakeOperationRouter } from "./utils/operationRouter";
export { getPartnerCookie } from "./utils/partner";
// Transform helpers
export {
  parseSlug,
  toBreadcrumbList,
  toFilters,
  toProduct,
} from "./utils/transform";
export { getUserCookie } from "./utils/user";
