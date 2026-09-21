/**
 * Wake app module — standard autoconfig contract.
 *
 * Exports `configure` following the AppModContract pattern; the framework's
 * `autoconfigApps()` calls it generically. Ported from the deco-cx/apps Deno
 * Wake integration.
 */

import type { AppDefinition, AppHandler, ResolveSecretFn } from "@decocms/apps-commerce/app-types";
import { configureWake, type WakeConfig } from "./client";
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
   * @description https://checkout.erploja2.com.br
   */
  checkoutUrl: string;
  /**
   * @title Wake Storefront Token
   * @description https://wakecommerce.readme.io/docs/storefront-api-criacao-e-autenticacao-do-token
   */
  storefrontToken: string;
  /**
   * @title Wake API token
   * @description The token for accessing wake commerce
   * @format password
   */
  token?: string;
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
 * Returns an AppDefinition or null if required fields are missing.
 */
export async function configure(
  block: Record<string, unknown> | null | undefined,
  resolveSecret: ResolveSecretFn,
): Promise<AppDefinition<WakeState> | null> {
  if (!block?.account) return null;

  const storefrontToken =
    (await resolveSecret(block.storefrontToken, "WAKE_TOKEN")) ??
    (typeof block.storefrontToken === "string" ? block.storefrontToken : null);

  if (!storefrontToken) return null;

  const token =
    (await resolveSecret(block.token, "WAKE_KEY")) ??
    (typeof block.token === "string" ? block.token : undefined) ??
    undefined;

  const config: WakeConfig = {
    account: block.account as string,
    checkoutUrl: (block.checkoutUrl as string) ?? "",
    storefrontToken,
    token: token ?? undefined,
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
