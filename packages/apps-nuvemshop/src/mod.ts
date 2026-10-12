/**
 * Nuvemshop app module — standard autoconfig contract (`AppModContract`).
 *
 * Block `deco-nuvemshop`:
 * ```json
 * { "storeId": "8336778", "token": { "__resolveType": "website/loaders/secret.ts", ... }, "currency": "BRL" }
 * ```
 * The token is optional (tokenless access works) but recommended in
 * production — see `client.ts` for the rate-limit trade-off.
 */
import type { AppDefinition, ResolveSecretFn } from "@decocms/apps-commerce/app-types";
import type { Secret } from "@decocms/apps-website/mod";
import { configureNuvemshop, type NuvemshopConfig } from "./client";
import manifest from "./manifest.gen";
import type { SortValue } from "./utils/listing";

// -------------------------------------------------------------------------
// CMS Props — the admin form for the `deco-nuvemshop` block. Sites expose it
// through a bridge (`src/apps/nuvemshop.ts` re-exporting this module's default
// and `Props`); generate-schema builds the form from this interface.
// -------------------------------------------------------------------------

/** @title Nuvemshop */
export interface Props {
  /**
   * @title Store ID
   * @description Numeric Nuvemshop/Tiendanube store id (e.g. 8336778).
   */
  storeId: string;
  /**
   * @title Storefront token
   * @description Optional. Without it all buyers share 120 req/min per IP; with it the store gets 1,200 req/min.
   */
  token?: Secret;
  /**
   * @title Currency
   * @description The API returns no currency. @default BRL
   */
  currency?: string;
  /**
   * @title Default category sort
   * @description The API doesn't expose the category's configured sort. @default created-descending
   */
  defaultSort?: SortValue;
  /**
   * @title API version
   * @default v2026-11
   */
  apiVersion?: string;
  /**
   * @title Store URL
   * @description The store's own domain (e.g. https://minhaloja.lojavirtualnuvem.com.br). Required for login/logout/account.
   */
  storeUrl?: string;
  /**
   * @title Admin API token
   * @description Custom app token (Configurações → Aplicativos sob medida). Server-only; enables registration and account data.
   */
  adminToken?: Secret;
  /**
   * @title Turnstile secret
   * @description Cloudflare Turnstile secret verified before registering customers (the Admin API has no captcha).
   */
  turnstileSecret?: Secret;
  /**
   * @title Allow registration without bot verification
   * @description Demos only.
   * @default false
   */
  allowUnverifiedRegistration?: boolean;
}

export interface NuvemshopState {
  config: NuvemshopConfig;
}

export async function configure(
  block: Record<string, unknown>,
  resolveSecret: ResolveSecretFn,
): Promise<AppDefinition<NuvemshopState> | null> {
  const storeId = block?.storeId == null ? "" : String(block.storeId);
  if (!/^\d+$/.test(storeId)) return null;

  const token =
    (await resolveSecret(block.token, "NUVEMSHOP_STOREFRONT_TOKEN")) ??
    (typeof block.token === "string" ? block.token : undefined);

  const secret = async (key: string, env: string) =>
    (await resolveSecret(block[key], env)) ??
    (typeof block[key] === "string" ? (block[key] as string) : undefined);
  const adminToken = await secret("adminToken", "NUVEMSHOP_ADMIN_TOKEN");
  const turnstileSecret = await secret("turnstileSecret", "NUVEMSHOP_TURNSTILE_SECRET");

  const config: NuvemshopConfig = {
    storeId,
    token: token || undefined,
    storeUrl: block.storeUrl as string | undefined,
    adminToken: adminToken || undefined,
    turnstileSecret: turnstileSecret || undefined,
    allowUnverifiedRegistration: block.allowUnverifiedRegistration === true,
    apiVersion: block.apiVersion as string | undefined,
    currency: block.currency as string | undefined,
    defaultSort: block.defaultSort as string | undefined,
  };
  configureNuvemshop(config);

  return { name: "nuvemshop", manifest, state: { config } };
}

export const preview = undefined;

/** Default export for schema generation and app bridges. */
export default function Nuvemshop(props: Props) {
  return { state: props };
}
