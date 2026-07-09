/**
 * Tests for algolia/client.ts.
 *
 * The goal is to lock the contract that downstream sites depend on:
 *  - configureAlgolia stores config and surfaces it via getAlgoliaConfig
 *  - getAlgoliaConfig throws a useful error when init never happened
 *  - getAlgoliaClient builds the SDK lazily and caches the instance
 *  - initAlgoliaFromBlocks dereferences Secret-shaped admin keys via
 *    `process.env` so prod CMS blocks (`{__resolveType:
 *    "website/loaders/secret.ts", name: "ADMIN_KEY"}`) work
 *
 * The SDK itself is mocked — we don't want network or fetch polyfills
 * pulled into the test runner; we only care that we call into
 * `algoliasearch(applicationId, adminApiKey)` with the right args.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const algoliasearchSpy = vi.fn(() => ({ __mockClient: true }));

vi.mock("algoliasearch", () => ({
	algoliasearch: (...args: unknown[]) =>
		algoliasearchSpy(...(args as Parameters<typeof algoliasearchSpy>)),
}));

// Importing after the mock so the production module picks up the
// mocked SDK. resetModules() in beforeEach keeps module-global state
// (cachedClient, config) isolated across tests.
let mod: typeof import("../client");

beforeEach(async () => {
	algoliasearchSpy.mockClear();
	vi.resetModules();
	mod = await import("../client");
});

afterEach(() => {
	delete process.env.TEST_ADMIN_KEY;
});

describe("configureAlgolia + getAlgoliaConfig", () => {
	it("returns the most recently configured values", () => {
		mod.configureAlgolia({ applicationId: "APP", searchApiKey: "S", adminApiKey: "A" });
		expect(mod.getAlgoliaConfig()).toEqual({
			applicationId: "APP",
			searchApiKey: "S",
			adminApiKey: "A",
		});
	});

	it("throws a helpful error when called before init", () => {
		expect(() => mod.getAlgoliaConfig()).toThrowError(/configureAlgolia/);
	});
});

describe("getAlgoliaClient", () => {
	it("constructs the SDK with applicationId + adminApiKey", () => {
		mod.configureAlgolia({ applicationId: "APP_X", searchApiKey: "S", adminApiKey: "ADMIN" });
		const client = mod.getAlgoliaClient();
		expect(algoliasearchSpy).toHaveBeenCalledExactlyOnceWith("APP_X", "ADMIN");
		expect(client).toEqual({ __mockClient: true });
	});

	it("caches the client across calls", () => {
		mod.configureAlgolia({ applicationId: "APP_X", searchApiKey: "S", adminApiKey: "ADMIN" });
		mod.getAlgoliaClient();
		mod.getAlgoliaClient();
		mod.getAlgoliaClient();
		expect(algoliasearchSpy).toHaveBeenCalledOnce();
	});

	it("rebuilds the client after configureAlgolia is called again", () => {
		mod.configureAlgolia({ applicationId: "APP_X", searchApiKey: "S", adminApiKey: "ADMIN1" });
		mod.getAlgoliaClient();
		mod.configureAlgolia({ applicationId: "APP_X", searchApiKey: "S", adminApiKey: "ADMIN2" });
		mod.getAlgoliaClient();
		expect(algoliasearchSpy).toHaveBeenCalledTimes(2);
		expect(algoliasearchSpy).toHaveBeenNthCalledWith(2, "APP_X", "ADMIN2");
	});

	it("throws when applicationId is missing", () => {
		mod.configureAlgolia({ applicationId: "", searchApiKey: "S", adminApiKey: "A" });
		expect(() => mod.getAlgoliaClient()).toThrowError(/applicationId/);
	});

	it("falls back to searchApiKey when adminApiKey is empty", () => {
		mod.configureAlgolia({ applicationId: "APP", searchApiKey: "SEARCH_ONLY", adminApiKey: "" });
		mod.getAlgoliaClient();
		expect(algoliasearchSpy).toHaveBeenCalledExactlyOnceWith("APP", "SEARCH_ONLY");
	});

	it("throws when both keys are empty", () => {
		mod.configureAlgolia({ applicationId: "APP", searchApiKey: "", adminApiKey: "" });
		expect(() => mod.getAlgoliaClient()).toThrowError(/adminApiKey or searchApiKey/);
	});

	it("prefers adminApiKey over searchApiKey when both present", () => {
		mod.configureAlgolia({ applicationId: "APP", searchApiKey: "S", adminApiKey: "ADMIN" });
		mod.getAlgoliaClient();
		expect(algoliasearchSpy).toHaveBeenCalledExactlyOnceWith("APP", "ADMIN");
	});
});

describe("initAlgoliaFromBlocks", () => {
	it("returns false and skips configure() when block is absent", async () => {
		const result = await mod.initAlgoliaFromBlocks({});
		expect(result).toBe(false);
		expect(() => mod.getAlgoliaConfig()).toThrowError(/configureAlgolia/);
	});

	it("reads applicationId + searchApiKey + adminApiKey from the block", async () => {
		const result = await mod.initAlgoliaFromBlocks({
			"deco-algolia": {
				applicationId: "APP",
				searchApiKey: "SEARCH",
				adminApiKey: "ADMIN_STRING",
			},
		});
		expect(result).toBe(true);
		expect(mod.getAlgoliaConfig()).toEqual({
			applicationId: "APP",
			searchApiKey: "SEARCH",
			adminApiKey: "ADMIN_STRING",
		});
	});

	it("dereferences a Secret-shaped adminApiKey via process.env", async () => {
		process.env.TEST_ADMIN_KEY = "from-env";
		await mod.initAlgoliaFromBlocks({
			"deco-algolia": {
				applicationId: "APP",
				searchApiKey: "SEARCH",
				adminApiKey: {
					__resolveType: "website/loaders/secret.ts",
					name: "TEST_ADMIN_KEY",
				},
			},
		});
		expect(mod.getAlgoliaConfig().adminApiKey).toBe("from-env");
	});

	it("falls back to empty string when env var is unset", async () => {
		await mod.initAlgoliaFromBlocks({
			"deco-algolia": {
				applicationId: "APP",
				searchApiKey: "SEARCH",
				adminApiKey: {
					__resolveType: "website/loaders/secret.ts",
					name: "UNDEFINED_ENV_VAR_DO_NOT_SET",
				},
			},
		});
		expect(mod.getAlgoliaConfig().adminApiKey).toBe("");
	});

	it("honors a custom block key", async () => {
		await mod.initAlgoliaFromBlocks(
			{
				"my-algolia": {
					applicationId: "X",
					searchApiKey: "Y",
					adminApiKey: "Z",
				},
			},
			"my-algolia",
		);
		expect(mod.getAlgoliaConfig().applicationId).toBe("X");
	});

	// Encrypted-secret flow: the CMS block ships `{ encrypted, name }`,
	// the framework's `resolveSecret` (from `@decocms/start/sdk/crypto`)
	// is supposed to AES-CBC decrypt `encrypted` using `DECO_CRYPTO_KEY`.
	// In a vitest worker `crypto.subtle` is available but the AES key
	// material isn't shipped to the runner — without `DECO_CRYPTO_KEY`,
	// `resolveSecret` skips the decrypt step and falls back to the env
	// var. That fallback path is what this test pins: prod sites either
	// set the env var on top OR (more commonly) rely on the decrypt to
	// succeed against the worker's `DECO_CRYPTO_KEY` binding.
	it("uses env var fallback when DECO_CRYPTO_KEY is unset and encrypted is present", async () => {
		delete process.env.DECO_CRYPTO_KEY;
		process.env.FALLBACK_ADMIN_KEY = "from-env-fallback";
		await mod.initAlgoliaFromBlocks({
			"deco-algolia": {
				applicationId: "APP",
				searchApiKey: "SEARCH",
				adminApiKey: {
					__resolveType: "website/loaders/secret.ts",
					encrypted: "deadbeef",
					name: "FALLBACK_ADMIN_KEY",
				},
			},
		});
		expect(mod.getAlgoliaConfig().adminApiKey).toBe("from-env-fallback");
		delete process.env.FALLBACK_ADMIN_KEY;
	});
});
