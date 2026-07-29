/**
 * Pre-wired instrumented fetch factory for Salesforce Commerce Cloud.
 *
 * Mirrors `vtex` / `shopify` / `magento`. Bundles `createInstrumentedFetch`
 * (spans, traceparent, URL redaction), the `salesforceOperationRouter`, and an
 * `onComplete` that records `http.client.request.duration` with
 * `provider: "salesforce"`.
 *
 * Salesforce has no module-global `_fetch`; instead `createHttpClient` defaults
 * its `fetcher` to {@link createSalesforceFetch}, so EVERY loader's egress is
 * instrumented automatically without per-loader wiring. Sites can still pass an
 * explicit `fetcher` to `createHttpClient` (e.g. for cookie passthrough) — wrap
 * it with `createSalesforceFetch({ baseFetch })` to keep the instrumentation.
 */

import {
  createInstrumentedFetch,
  type InstrumentedFetch,
} from "@decocms/blocks/sdk/instrumentedFetch";
import { recordCommerceMetric, statusClassFor } from "@decocms/blocks/sdk/observability";
import { salesforceOperationRouter } from "./operationRouter";

export interface CreateSalesforceFetchOptions {
  /** Underlying fetch to wrap. Defaults to `globalThis.fetch`. */
  baseFetch?: typeof fetch;
  /** Disable the histogram (spans + logs still emit). Default: false. */
  disableHistogram?: boolean;
}

export function createSalesforceFetch(
  options: CreateSalesforceFetchOptions = {},
): InstrumentedFetch {
  const { baseFetch, disableHistogram = false } = options;
  return createInstrumentedFetch({
    name: "salesforce",
    baseFetch,
    resolveOperation: salesforceOperationRouter,
    onComplete: disableHistogram
      ? undefined
      : ({ operation, status, durationMs, cached }) => {
          recordCommerceMetric(durationMs, {
            provider: "salesforce",
            operation,
            status_class: statusClassFor(status),
            cached,
          });
        },
  });
}
