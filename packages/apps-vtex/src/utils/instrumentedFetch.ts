/**
 * Pre-wired instrumented fetch factory for VTEX.
 *
 * Bundles the three pieces a storefront would otherwise have to wire
 * by hand:
 *
 *   1. The `createInstrumentedFetch` boundary from `@decocms/start`
 *      (spans, traceparent injection, URL redaction, cache-header
 *      span attributes).
 *   2. The `vtexOperationRouter` URL→operation mapping so unannotated
 *      callsites still get semantic span names + histogram labels.
 *   3. An `onComplete` callback that records every call into the
 *      canonical `http.client.request.duration` histogram via the
 *      framework's `recordCommerceMetric(...)` helper in
 *      `@decocms/start/sdk/observability` — `provider`, `operation`,
 *      `status_class`, and `cached` labels.
 *
 * Sites opt in once at startup:
 *
 *   ```ts
 *   import { setVtexFetch } from "@decocms/apps/vtex";
 *   import { createVtexFetch } from "@decocms/apps/vtex";
 *
 *   setVtexFetch(createVtexFetch());
 *   ```
 *
 * Sites that need to wrap a custom underlying fetch (cookie passthrough,
 * proxy, retry, etc.) pass it as `baseFetch`. The instrumentation
 * still applies — `createInstrumentedFetch` preserves the wrapped
 * behavior.
 */

import {
	createInstrumentedFetch,
	type InstrumentedFetch,
} from "@decocms/blocks/sdk/instrumentedFetch";
import { recordCommerceMetric } from "@decocms/blocks/sdk/observability";
import { vtexOperationRouter } from "./operationRouter";

export interface CreateVtexFetchOptions {
	/**
	 * Underlying fetch to wrap. Defaults to `globalThis.fetch`.
	 * Pass an existing custom fetch (e.g. one that injects auth cookies
	 * or routes through a proxy) to preserve its behavior while adding
	 * the VTEX instrumentation layer on top.
	 */
	baseFetch?: typeof fetch;
	/**
	 * Disable the `http.client.request.duration` histogram emission for
	 * VTEX calls. The framework's span and structured logs still emit.
	 * Useful when the consumer wants to record its own histogram with a
	 * custom shape. Default: false.
	 */
	disableHistogram?: boolean;
}

/**
 * Construct a pre-wired VTEX `InstrumentedFetch`. Pass the result to
 * `setVtexFetch(...)`. See module docstring for details.
 */
export function createVtexFetch(options: CreateVtexFetchOptions = {}): InstrumentedFetch {
	const { baseFetch, disableHistogram = false } = options;
	return createInstrumentedFetch({
		name: "vtex",
		baseFetch,
		resolveOperation: vtexOperationRouter,
		onComplete: disableHistogram
			? undefined
			: ({ operation, status, durationMs, cached }) => {
					recordCommerceMetric(durationMs, {
						provider: "vtex",
						operation,
						status_class: `${Math.floor(status / 100)}xx`,
						cached,
					});
				},
	});
}
