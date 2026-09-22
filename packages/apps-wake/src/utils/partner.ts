import { getCookies, setCookie } from "./cookies";
import { isSecureRequest } from "./requestCtx";

const PARTNER_COOKIE = "partner-token";

const TEN_DAYS_MS = 10 * 24 * 3600 * 1_000;

export const getPartnerCookie = (headers: Headers): string | undefined => {
  const cookies = getCookies(headers);

  return cookies[PARTNER_COOKIE];
};

export const setPartnerCookie = (headers: Headers, partnerToken: string) =>
  setCookie(headers, {
    name: PARTNER_COOKIE,
    value: partnerToken,
    path: "/",
    expires: new Date(Date.now() + TEN_DAYS_MS),
    // Server-only token — nothing client-side reads it.
    httpOnly: true,
    // Secure only on HTTPS — a Secure cookie is dropped over http:// (localhost dev).
    secure: isSecureRequest(),
    sameSite: "Lax",
  });

export const deletePartnerCookie = (headers: Headers) =>
  setCookie(headers, {
    name: PARTNER_COOKIE,
    value: "",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
  });
