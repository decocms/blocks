import { getCookies, setCookie } from "./cookies";

const CART_COOKIE = "carrinho-id";

const TEN_DAYS_MS = 10 * 24 * 3600 * 1_000;

export const getCartCookie = (headers: Headers): string | undefined => {
  const cookies = getCookies(headers);

  return cookies[CART_COOKIE];
};

export const setCartCookie = (headers: Headers, cartId: string) =>
  setCookie(headers, {
    name: CART_COOKIE,
    value: cartId,
    path: "/",
    expires: new Date(Date.now() + TEN_DAYS_MS),
  });

/** Browser-only: mirror the cart id into a client-readable cookie. */
export const setClientCookie = (value: string) => {
  const date = new Date(Date.now() + TEN_DAYS_MS);
  const expires = `; expires=${date.toUTCString()}`;

  // biome-ignore lint/suspicious/noDocumentCookie: browser-only mirror of the cart id for client reads
  document.cookie = `${CART_COOKIE}=${value || ""}${expires}; path=/`;
};
