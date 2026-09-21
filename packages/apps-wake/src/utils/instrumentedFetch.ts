/**
 * Pre-wired instrumented fetch factory for Wake. Mirrors
 * `apps-shopify/utils/instrumentedFetch.ts`.
 *
 * Bundles `createInstrumentedFetch` (spans, traceparent, URL redaction), the
 * `wakeOperationRouter` URL fallback, and an `onComplete` that records the
 * canonical `http.client.request.duration` histogram with `provider: "wake"`.
 *
 * Sites do:
 * ```ts
 * import { setWakeFetch, createWakeFetch } from "@decocms/apps-wake";
 * setWakeFetch(createWakeFetch());
 * ```
 */

import type { FetchFn } from "@decocms/blocks/sdk/fetchTimeout";
import {
  createInstrumentedFetch,
  type InstrumentedFetch,
} from "@decocms/blocks/sdk/instrumentedFetch";
import { recordCommerceMetric } from "@decocms/blocks/sdk/observability";
import { wakeOperationRouter } from "./operationRouter";

export interface CreateWakeFetchOptions {
  baseFetch?: FetchFn;
  disableHistogram?: boolean;
}

export function createWakeFetch(options: CreateWakeFetchOptions = {}): InstrumentedFetch {
  const { baseFetch, disableHistogram = false } = options;
  return createInstrumentedFetch({
    name: "wake",
    baseFetch,
    resolveOperation: wakeOperationRouter,
    onComplete: disableHistogram
      ? undefined
      : ({ operation, status, durationMs, cached }) => {
          recordCommerceMetric(durationMs, {
            provider: "wake",
            operation,
            status_class: `${Math.floor(status / 100)}xx`,
            cached,
          });
        },
  });
}
