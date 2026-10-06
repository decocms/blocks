/**
 * Pre-wired instrumented fetch for Nuvemshop — mirrors the Magento/Shopify
 * factories: spans + `http.client.request.duration` with
 * `provider: "nuvemshop"`. It is the client's default transport (like
 * Salesforce), so sites get instrumentation without calling
 * `setNuvemshopFetch`. SWR hit/miss is emitted by `createFetchCache`.
 */

import type { FetchFn } from "@decocms/blocks/sdk/fetchTimeout";
import {
  createInstrumentedFetch,
  type InstrumentedFetch,
} from "@decocms/blocks/sdk/instrumentedFetch";
import { recordCommerceMetric, statusClassFor } from "@decocms/blocks/sdk/observability";
import { nuvemshopOperationRouter } from "./operationRouter";

export interface CreateNuvemshopFetchOptions {
  /** Underlying fetch to wrap. Defaults to `globalThis.fetch`. */
  baseFetch?: FetchFn;
  /** Disable the duration histogram (spans/logs still emit). Default: false. */
  disableHistogram?: boolean;
}

export function createNuvemshopFetch(options: CreateNuvemshopFetchOptions = {}): InstrumentedFetch {
  const { baseFetch, disableHistogram = false } = options;
  return createInstrumentedFetch({
    name: "nuvemshop",
    baseFetch,
    resolveOperation: nuvemshopOperationRouter,
    onComplete: disableHistogram
      ? undefined
      : (r) =>
          recordCommerceMetric(r.durationMs, {
            provider: "nuvemshop",
            operation: r.operation,
            status_class: statusClassFor(r.status),
            cached: r.cached,
          }),
  });
}
