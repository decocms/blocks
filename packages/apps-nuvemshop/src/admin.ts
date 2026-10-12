/**
 * Nuvemshop Admin API (`api.nuvemshop.com.br/v1/<store>`) — server-only.
 * Authenticated with a custom-app token (`adminToken`); used for what the
 * Storefront API lacks: customer registration (no reCAPTCHA) and account data.
 */
import { getNuvemshopConfig, nuvemshopFetch } from "./client";

const ADMIN_BASE = "https://api.nuvemshop.com.br/v1";

export async function nuvemshopAdmin(path: string, init: { method?: string; body?: unknown } = {}) {
  const { storeId, adminToken } = getNuvemshopConfig();
  if (!adminToken) throw new Error("Nuvemshop adminToken is not configured (custom app token)");
  return nuvemshopFetch(`${ADMIN_BASE}/${storeId}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authentication: `bearer ${adminToken}`,
      // Nuvemshop requires an identifying User-Agent on Admin API calls.
      "user-agent": "deco.cx storefront (https://deco.cx)",
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
