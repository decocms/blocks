/**
 * Wake app module — standard autoconfig contract.
 *
 * Exports `configure` following the AppModContract pattern; the framework's
 * `autoconfigApps()` calls it generically. Ported from the deco-cx/apps Deno
 * Wake integration.
 */

import type { AppDefinition, AppHandler, ResolveSecretFn } from "@decocms/apps-commerce/app-types";
import {
  configureWake,
  getWakeAdminTokenFromEnv,
  getWakeStorefrontTokenFromEnv,
  type WakeConfig,
} from "./client";
import Sitemap from "./handlers/sitemap";
import manifest from "./manifest.gen";

/** @title Wake */
export interface Props {
  /**
   * @title Account Name
   * @description erploja2 etc
   */
  account: string;
  /**
   * @title Checkout Url
   * @description https://secure.sprint55.com.br — checkout/login domain
   */
  checkoutUrl: string;
  /**
   * @description Use Wake as backend platform
   * @hide true
   */
  platform?: "wake";
}

export interface WakeState {
  config: WakeConfig;
}

/**
 * Configure the Wake app from CMS block data.
 *
 * The Wake tokens are NOT stored in the CMS block — they come only from
 * environment variables (`WAKE_TOKEN` storefront, `WAKE_KEY` admin), so
 * `resolveSecret` is intentionally unused. Returns null if the account or the
 * storefront token env var is missing.
 */
export async function configure(
  block: Record<string, unknown> | null | undefined,
  _resolveSecret: ResolveSecretFn,
): Promise<AppDefinition<WakeState> | null> {
  if (!block?.account) return null;

  const storefrontToken = getWakeStorefrontTokenFromEnv();
  if (!storefrontToken) return null;

  const config: WakeConfig = {
    account: block.account as string,
    checkoutUrl: (block.checkoutUrl as string) ?? "",
    storefrontToken,
    storefrontEndpoint: block.storefrontEndpoint as string | undefined,
    token: getWakeAdminTokenFromEnv(),
  };

  // Bridge: maintain global singleton for backward compat
  configureWake(config);

  return {
    name: "wake",
    manifest,
    state: { config },
  };
}

/** HTTP handlers exposed by the app (not part of the loader/action manifest). */
export const handlers: Record<string, AppHandler> = {
  "wake/handlers/sitemap": (props, request) => Sitemap(props)(request),
};

/** Placeholder preview for CMS editor — evolves when admin supports it. */
export const preview = undefined;

/** Default export for schema generation and Deno-style app bridges. */
export default function Wake(props: Props) {
  return { state: props };
}
