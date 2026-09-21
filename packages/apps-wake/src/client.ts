import type { FetchFn } from "@decocms/blocks/sdk/fetchTimeout";
import { createGraphqlClient, type GraphQLClient } from "./utils/graphql";

export interface WakeConfig {
  /** Wake account name, e.g. "erploja2". */
  account: string;
  /**
   * Checkout/login domain, e.g. "https://secure.sprint55.com.br". Used only for
   * the checkout REST API (login/cart) and proxy — NOT for the storefront
   * GraphQL, which is a fixed multi-tenant endpoint resolved by the token.
   */
  checkoutUrl: string;
  /** Wake Storefront API token (sent as `TCS-Access-Token`). */
  storefrontToken: string;
  /**
   * Storefront GraphQL endpoint. Defaults to Wake's canonical multi-tenant
   * endpoint; override only for a custom storefront host.
   */
  storefrontEndpoint?: string;
  /** Wake Admin API token (Basic auth). Currently unused by the loaders/actions. */
  token?: string;
}

const STOREFRONT_ENDPOINT = "https://storefront-api.fbits.net/graphql";

/**
 * Read an env var. Wake's tokens are provided ONLY via environment variables
 * (no CMS secret / `resolveSecret`): `WAKE_TOKEN` (storefront) and, if ever
 * needed, `WAKE_KEY` (admin). `process.env` is populated in Node and in
 * Cloudflare Workers via `nodejs_compat` — the same source the framework's
 * own `getEnvVar()` reads first.
 */
function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const value = env?.[name];
  return value && value.length > 0 ? value : undefined;
}

/** Wake Storefront API token from `WAKE_TOKEN`. */
export function getWakeStorefrontTokenFromEnv(): string | undefined {
  return readEnv("WAKE_TOKEN");
}

/** Wake Admin API token from `WAKE_KEY` (currently unused by loaders/actions). */
export function getWakeAdminTokenFromEnv(): string | undefined {
  return readEnv("WAKE_KEY");
}

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
  const endpoint = config.storefrontEndpoint || STOREFRONT_ENDPOINT;
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
    // Tokens come from env only (WAKE_TOKEN / WAKE_KEY), never the CMS block.
    storefrontToken: getWakeStorefrontTokenFromEnv() ?? "",
    storefrontEndpoint: block.storefrontEndpoint as string | undefined,
    token: getWakeAdminTokenFromEnv(),
  });
}
