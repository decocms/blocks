/**
 * Tests for the Magento client config + magentoFetch wrapper.
 *
 * Parity goals — behavior these tests pin down so the port stays aligned
 * with deco-cx/apps/magento (Fresh/Deno, prod):
 *
 *  - configureMagento / getMagentoConfig is a write-once-read-many global
 *    (mirrors configureVtex). getMagentoConfig() throws before configure().
 *  - magentoFetch:
 *      • Same-origin: attaches Authorization (Bearer apiKey),
 *        x-origin-header (when configured), and a forced Referer pointing
 *        at baseUrl — exactly the headers the Fresh `clientAdmin` was
 *        built with at App() time.
 *      • Cross-origin: strips ALL Magento-only identity headers so the
 *        admin Bearer + origin secret never leak to a third party. Caller
 *        headers pass through.
 *      • authenticated:false opt-out drops Bearer even on same-origin.
 *      • Relative paths resolve against baseUrl with proper "/" handling.
 *      • Absolute https://… paths bypass baseUrl entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureMagento, getMagentoConfig, magentoFetch } from "../client";

// Reset module-global config between tests by re-importing.
beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("configureMagento / getMagentoConfig", () => {
	it("throws before configureMagento() is called", async () => {
		const { getMagentoConfig: freshGet } = await import("../client");
		expect(() => freshGet()).toThrow(/configureMagento\(\) must be called/);
	});

	it("returns the configured value after configureMagento()", async () => {
		const { configureMagento: c, getMagentoConfig: g } = await import("../client");
		c({
			baseUrl: "https://loja.example.com/",
			apiKey: "test-key",
			storeId: 1,
			site: "example",
		});
		expect(g().baseUrl).toBe("https://loja.example.com/");
		expect(g().apiKey).toBe("test-key");
	});
});

describe("magentoFetch — same-origin (configured baseUrl)", () => {
	const baseUrl = "https://loja.example.com/";
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		configureMagento({
			baseUrl,
			apiKey: "secret-bearer",
			storeId: 1,
			site: "example",
			originHeader: "origin-secret",
		});
		fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
			);
	});

	it("attaches Authorization, x-origin-header, and forced Referer", async () => {
		await magentoFetch("/rest/example/V1/carts/123");
		const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("authorization")).toBe("Bearer secret-bearer");
		expect(headers.get("x-origin-header")).toBe("origin-secret");
		expect(headers.get("referer")).toBe(baseUrl);
	});

	it("resolves relative path against baseUrl with correct slash handling", async () => {
		await magentoFetch("rest/example/V1/carts/123"); // no leading slash
		const [target] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		expect(target.toString()).toBe("https://loja.example.com/rest/example/V1/carts/123");
	});

	it("authenticated:false suppresses Bearer even on same-origin", async () => {
		await magentoFetch("/rest/example/V1/carts/123", { authenticated: false });
		const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("authorization")).toBeNull();
		// Same-origin still gets the other Magento-identity headers.
		expect(headers.get("x-origin-header")).toBe("origin-secret");
	});

	it("preserves caller-supplied Referer (no force-overwrite when caller set one)", async () => {
		await magentoFetch("/rest/example/V1/carts/123", {
			headers: { Referer: "https://caller.example/page" },
		});
		const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("referer")).toBe("https://caller.example/page");
	});
});

describe("magentoFetch — cross-origin guard", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		configureMagento({
			baseUrl: "https://loja.example.com/",
			apiKey: "secret-bearer",
			storeId: 1,
			site: "example",
			originHeader: "origin-secret",
		});
		fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
	});

	it("strips Bearer when fetching a non-Magento host", async () => {
		await magentoFetch("https://attacker.example/api");
		const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("authorization")).toBeNull();
	});

	it("strips x-origin-header when fetching a non-Magento host", async () => {
		// Regression for cubic review: the previous fix only dropped Bearer
		// while x-origin-header and Referer still leaked.
		await magentoFetch("https://attacker.example/api");
		const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("x-origin-header")).toBeNull();
	});

	it("strips forced Referer when fetching a non-Magento host", async () => {
		await magentoFetch("https://attacker.example/api");
		const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		const headers = init.headers as Headers;
		// Referer to https://loja.example.com/ would broadcast the Magento
		// host to the third party — must not be set by us.
		expect(headers.get("referer")).toBeNull();
	});

	it("still forwards caller-supplied headers cross-origin", async () => {
		await magentoFetch("https://partner.example/api", {
			headers: { "x-correlation-id": "abc123" },
		});
		const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("x-correlation-id")).toBe("abc123");
	});

	it("treats an absolute URL with the same origin as same-origin", async () => {
		await magentoFetch("https://loja.example.com/rest/example/V1/carts/123");
		const [target, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
		expect(target.toString()).toBe("https://loja.example.com/rest/example/V1/carts/123");
		expect((init.headers as Headers).get("authorization")).toBe("Bearer secret-bearer");
	});
});

describe("initMagentoFromBlocks — secret resolution", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("returns early when the `magento` block is absent", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { initMagentoFromBlocks, getMagentoConfig } = await import("../client");
		await initMagentoFromBlocks({});
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("No `magento` block"));
		expect(() => getMagentoConfig()).toThrow(/configureMagento\(\) must be called/);
	});

	it("reads plain-string apiKey directly", async () => {
		const { initMagentoFromBlocks, getMagentoConfig } = await import("../client");
		await initMagentoFromBlocks({
			magento: {
				apiConfig: {
					baseUrl: "https://loja.example.com/",
					apiKey: "plain-string-key",
					site: "example",
					storeId: 1,
				},
			},
		});
		expect(getMagentoConfig().apiKey).toBe("plain-string-key");
	});

	it("dereferences a Secret-shaped apiKey via process.env (the env fallback path)", async () => {
		process.env.TEST_MAGENTO_KEY = "from-env";
		const { initMagentoFromBlocks, getMagentoConfig } = await import("../client");
		await initMagentoFromBlocks({
			magento: {
				apiConfig: {
					baseUrl: "https://loja.example.com/",
					apiKey: {
						__resolveType: "website/loaders/secret.ts",
						name: "TEST_MAGENTO_KEY",
					},
					site: "example",
					storeId: 1,
				},
			},
		});
		expect(getMagentoConfig().apiKey).toBe("from-env");
		delete process.env.TEST_MAGENTO_KEY;
	});

	it("falls back to empty string when secret is unresolvable", async () => {
		// no DECO_CRYPTO_KEY, no env var with this name, no decrypt
		// → resolveSecret returns null → init writes "".
		delete process.env.DECO_CRYPTO_KEY;
		const { initMagentoFromBlocks, getMagentoConfig } = await import("../client");
		await initMagentoFromBlocks({
			magento: {
				apiConfig: {
					baseUrl: "https://loja.example.com/",
					apiKey: {
						__resolveType: "website/loaders/secret.ts",
						encrypted: "deadbeef",
						name: "UNDEFINED_ENV_VAR_DO_NOT_SET",
					},
					site: "example",
					storeId: 1,
				},
			},
		});
		expect(getMagentoConfig().apiKey).toBe("");
	});

	it("resolves both apiKey and originHeader independently", async () => {
		process.env.TEST_API_KEY = "api-from-env";
		process.env.TEST_ORIGIN = "origin-from-env";
		const { initMagentoFromBlocks, getMagentoConfig } = await import("../client");
		await initMagentoFromBlocks({
			magento: {
				apiConfig: {
					baseUrl: "https://loja.example.com/",
					apiKey: { name: "TEST_API_KEY" },
					originHeader: { name: "TEST_ORIGIN" },
					site: "example",
					storeId: 1,
				},
			},
		});
		const cfg = getMagentoConfig();
		expect(cfg.apiKey).toBe("api-from-env");
		expect(cfg.originHeader).toBe("origin-from-env");
		delete process.env.TEST_API_KEY;
		delete process.env.TEST_ORIGIN;
	});
});
