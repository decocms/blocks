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
import { configureNuvemshop, type NuvemshopConfig } from "./client";
import manifest from "./manifest.gen";

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

  const config: NuvemshopConfig = {
    storeId,
    token: token || undefined,
    apiVersion: block.apiVersion as string | undefined,
    currency: block.currency as string | undefined,
    defaultSort: block.defaultSort as string | undefined,
  };
  configureNuvemshop(config);

  return { name: "nuvemshop", manifest, state: { config } };
}

export const preview = undefined;
