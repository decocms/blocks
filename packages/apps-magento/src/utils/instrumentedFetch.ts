/**
 * Pre-wired instrumented fetch factory for Magento.
 *
 * Mirrors `vtex/utils/instrumentedFetch.ts` and `shopify/utils/instrumentedFetch.ts`.
 * Bundles:
 *
 *   1. `createInstrumentedFetch` from `@decocms/blocks/sdk/instrumentedFetch`
 *      (spans, traceparent injection, URL redaction, cache-header span attrs).
 *   2. `magentoOperationRouter` as the URL→operation fallback.
 *   3. An `onComplete` that records the canonical
 *      `http.client.request.duration` histogram via the framework's
 *      `recordCommerceMetric(...)` helper with `provider: "magento"`.
 *
 * Sites opt in once at startup:
 *
 *   ```ts
 *   import { createMagentoFetch, setMagentoFetch } from "@decocms/apps/magento";
 *   setMagentoFetch(createMagentoFetch());
 *   ```
 *
 * With this wired, every Magento egress call (GraphQL + REST) funnels through
 * one instrumented boundary, so upstream latency/status lands in ClickHouse.
 * SWR hit/miss for cached GETs is emitted separately by
 * `@decocms/blocks/sdk/fetchCache` (see `./fetchCache.ts`).
 */

import {
  createInstrumentedFetch,
  type InstrumentedFetch,
} from "@decocms/blocks/sdk/instrumentedFetch";
import { recordCommerceMetric, statusClassFor } from "@decocms/blocks/sdk/observability";
import { magentoOperationRouter } from "./operationRouter";

export interface CreateMagentoFetchOptions {
  /** Underlying fetch to wrap. Defaults to `globalThis.fetch`. */
  baseFetch?: typeof fetch;
  /**
   * Disable the `http.client.request.duration` histogram for Magento calls.
   * Spans + structured logs still emit. Default: false.
   */
  disableHistogram?: boolean;
}

/**
 * Construct a pre-wired Magento `InstrumentedFetch`. Pass the result to
 * `setMagentoFetch(...)`.
 */
export function createMagentoFetch(options: CreateMagentoFetchOptions = {}): InstrumentedFetch {
  const { baseFetch, disableHistogram = false } = options;
  return createInstrumentedFetch({
    name: "magento",
    baseFetch,
    resolveOperation: magentoOperationRouter,
    onComplete: disableHistogram ? undefined : (r) =>
      recordCommerceMetric(r.durationMs, { provider: "magento", operation: r.operation, status_class: statusClassFor(r.status), cached: r.cached }),
  });
}
