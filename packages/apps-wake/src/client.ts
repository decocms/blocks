import type { FetchFn } from "@decocms/blocks/sdk/fetchTimeout";
import { createGraphqlClient, type GraphQLClient } from "./utils/graphql";

export interface WakeConfig {
  /** Wake account name, e.g. "erploja2". */
  account: string;
  /** Checkout URL, e.g. "https://checkout.erploja2.com.br". */
  checkoutUrl: string;
  /** Wake Storefront API token (sent as `TCS-Access-Token`). */
  storefrontToken: string;
  /** Wake Admin API token (Basic auth). Currently unused by the loaders/actions. */
  token?: string;
}

const STOREFRONT_FALLBACK = "https://storefront-api.fbits.net";

let _client: GraphQLClient | null = null;
let _config: WakeConfig | null = null;
let _fetch: FetchFn | undefined;

/**
 * Override the fetch function used by the Wake GraphQL client. Use this to plug
 * in an instrumented fetch for logging/tracing.
 *
 * @example
 * ```ts
 * import { createInstrumentedFetch } from "@decocms/blocks/sdk/instrumentedFetch";
 * import { setWakeFetch } from "@decocms/apps-wake";
 * setWakeFetch(createInstrumentedFetch("wake"));
 * ```
 */
export function setWakeFetch(fetchFn: FetchFn) {
  _fetch = fetchFn;
  if (_config) configureWake(_config);
}

export function configureWake(config: WakeConfig) {
  _config = config;
  const endpoint = new URL("/graphql", config.checkoutUrl || STOREFRONT_FALLBACK).href;
  _client = createGraphqlClient(
    endpoint,
    {
      "TCS-Access-Token": config.storefrontToken,
    },
    _fetch,
  );
}

export function getWakeClient(): GraphQLClient {
  if (!_client || !_config) {
    throw new Error(
      "Wake not configured. Call configureWake() first or check deco-wake.json block.",
    );
  }
  return _client;
}

export function getWakeConfig(): WakeConfig {
  if (!_config) {
    throw new Error("Wake not configured.");
  }
  return _config;
}

/** Base URL of the checkout REST API (`GET /api/Login/Get`, proxied paths). */
export function getCheckoutUrl(): string {
  const config = getWakeConfig();
  return config.checkoutUrl || `https://${config.account}.checkout.fbits.store`;
}

export function getBaseUrl(): string {
  return _config?.checkoutUrl || "";
}

/**
 * Convenience initializer used by the site setup: reads the Wake app block from
 * the generated blocks map and configures the singleton.
 */
export function initWakeFromBlocks(blocks: Record<string, unknown>) {
  const block = (blocks.wake ?? blocks["deco-wake"]) as Partial<WakeConfig> | undefined;
  if (!block?.account) return;
  configureWake({
    account: block.account as string,
    checkoutUrl: (block.checkoutUrl as string) ?? "",
    storefrontToken: (block.storefrontToken as string) ?? "",
    token: block.token as string | undefined,
  });
}
