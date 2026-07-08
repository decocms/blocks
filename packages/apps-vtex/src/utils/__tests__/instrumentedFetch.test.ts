/**
 * Smoke tests for the pre-wired VTEX fetch factory.
 *
 * The deep coverage of `createInstrumentedFetch` lives in @decocms/start;
 * here we only verify the apps-start wiring decisions:
 *
 *   - The URL router is plumbed through so unannotated callsites get
 *     semantic span operations + histogram labels.
 *   - The canonical `http.client.request.duration` histogram is recorded
 *     with the right labels on every call (via the framework's
 *     `recordCommerceMetric` helper).
 *   - `disableHistogram: true` opts out cleanly.
 *   - A caller's explicit `init.operation` wins over the URL router
 *     (delegating to the framework, but worth asserting at this seam).
 */

import { configureMeter, type MeterAdapter } from "@decocms/blocks/sdk/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVtexFetch } from "../instrumentedFetch";

type Labels = Record<string, string | number | boolean>;
type HistogramCall = {
	name: string;
	value: number;
	attrs: Labels;
};

function captureHistogram(): { calls: HistogramCall[]; meter: MeterAdapter } {
	const calls: HistogramCall[] = [];
	const meter: MeterAdapter = {
		counterInc: vi.fn(),
		gaugeSet: vi.fn(),
		histogramRecord: (name, value, attrs) => {
			calls.push({ name, value, attrs: attrs ?? {} });
		},
	};
	return { calls, meter };
}

function mockOkResponse(status = 200): Response {
	return new Response(JSON.stringify({}), { status });
}

describe("createVtexFetch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		configureMeter({
			counterInc: () => {},
			gaugeSet: () => {},
			histogramRecord: () => {},
		});
	});

	it("records http.client.request.duration with provider/operation/status labels on success", async () => {
		const { calls, meter } = captureHistogram();
		configureMeter(meter);

		const baseFetch = vi.fn(async () => mockOkResponse(200));
		const fetchFn = createVtexFetch({ baseFetch: baseFetch as typeof fetch });

		await fetchFn("https://store.vtexcommercestable.com.br/api/sessions");

		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("http.client.request.duration");
		expect(calls[0].attrs).toMatchObject({
			provider: "vtex",
			operation: "sessions.get",
			status_class: "2xx",
			cached: false,
		});
		expect(calls[0].value).toBeGreaterThanOrEqual(0);
	});

	it("uses the URL router for unannotated calls", async () => {
		const { calls, meter } = captureHistogram();
		configureMeter(meter);

		const baseFetch = vi.fn(async () => mockOkResponse(200));
		const fetchFn = createVtexFetch({ baseFetch: baseFetch as typeof fetch });

		await fetchFn(
			"https://store.vtexcommercestable.com.br/api/io/_v/api/intelligent-search/product_search/foo",
		);

		expect(calls[0].attrs.operation).toBe("intelligent-search.product_search");
	});

	it("honors init.operation over the URL router", async () => {
		const { calls, meter } = captureHistogram();
		configureMeter(meter);

		const baseFetch = vi.fn(async () => mockOkResponse(200));
		const fetchFn = createVtexFetch({ baseFetch: baseFetch as typeof fetch });

		await fetchFn("https://store.vtexcommercestable.com.br/api/sessions", {
			operation: "explicit.custom_op",
		});

		expect(calls[0].attrs.operation).toBe("explicit.custom_op");
	});

	it("records cached=true when the response carries x-cache: HIT", async () => {
		const { calls, meter } = captureHistogram();
		configureMeter(meter);

		const baseFetch = vi.fn(
			async () => new Response("{}", { status: 200, headers: { "x-cache": "HIT" } }),
		);
		const fetchFn = createVtexFetch({ baseFetch: baseFetch as typeof fetch });

		await fetchFn("https://store.vtexcommercestable.com.br/api/sessions");

		expect(calls[0].attrs.cached).toBe(true);
	});

	it("emits status_class derived from the actual response status", async () => {
		const { calls, meter } = captureHistogram();
		configureMeter(meter);

		const baseFetch = vi.fn(async () => mockOkResponse(503));
		const fetchFn = createVtexFetch({ baseFetch: baseFetch as typeof fetch });

		await fetchFn("https://store.vtexcommercestable.com.br/api/sessions");

		expect(calls[0].attrs.status_class).toBe("5xx");
	});

	it("skips histogram emission when disableHistogram is true", async () => {
		const { calls, meter } = captureHistogram();
		configureMeter(meter);

		const baseFetch = vi.fn(async () => mockOkResponse(200));
		const fetchFn = createVtexFetch({
			baseFetch: baseFetch as typeof fetch,
			disableHistogram: true,
		});

		await fetchFn("https://store.vtexcommercestable.com.br/api/sessions");

		expect(calls).toHaveLength(0);
	});

	it("does not surface the operation field to the underlying fetch", async () => {
		const { meter } = captureHistogram();
		configureMeter(meter);

		const baseFetch = vi.fn(async (_input: unknown, _init?: RequestInit) => mockOkResponse(200));
		const fetchFn = createVtexFetch({ baseFetch: baseFetch as unknown as typeof fetch });

		await fetchFn("https://store.vtexcommercestable.com.br/api/sessions", {
			operation: "explicit.op",
		});

		expect(baseFetch).toHaveBeenCalledOnce();
		const init = baseFetch.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
		expect(init?.operation).toBeUndefined();
	});
});
