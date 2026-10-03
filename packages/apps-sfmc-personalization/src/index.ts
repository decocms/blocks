/**
 * `@decocms/apps-sfmc-personalization`: a thin client for Salesforce
 * Marketing Cloud Personalization (formerly Evergage). See /next/upstream-clients.
 *
 * Every request goes through `createInstrumentedFetch` with provider
 * `sfmc-personalization`. No retries or circuit breaker. Reading the
 * shopper's cookie, converting products to commerce types and caching belong
 * to the site (platform templates and site code).
 */
import { createInstrumentedFetch } from "@decocms/blocks/fetch";
import type { PersonalizationEvent, PersonalizationResponse } from "./types";

export type {
  CampaignResponse,
  PersonalizationEvent,
  PersonalizationLineItem,
  PersonalizationProduct,
  PersonalizationResponse,
} from "./types";

export interface SfmcPersonalizationConfig {
  /** The account's API origin, e.g. `https://<account>.<instance>.evergage.com`. */
  baseUrl: string;
  /** The dataset events are sent to. */
  dataset: string;
}

export class SfmcPersonalizationError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`sfmc-personalization ${operation} failed with HTTP ${status}`);
  }
}

export function createSfmcPersonalizationClient(
  config: SfmcPersonalizationConfig,
  options: { fetch?: typeof fetch } = {},
) {
  const request = createInstrumentedFetch({
    provider: "sfmc-personalization",
    fetch: options.fetch,
  });

  return {
    /** Sends an interaction and returns the campaigns it triggered. */
    async sendEvent(event: PersonalizationEvent): Promise<PersonalizationResponse> {
      const url = new URL(`/api2/event/${encodeURIComponent(config.dataset)}`, config.baseUrl);
      const response = await request(url, {
        operation: "sendEvent",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!response.ok) throw new SfmcPersonalizationError("sendEvent", response.status);
      return (await response.json()) as PersonalizationResponse;
    },
  };
}

export type SfmcPersonalizationClient = ReturnType<typeof createSfmcPersonalizationClient>;
