/**
 * Magento API client config — module-global, set once at app boot.
 *
 * Mirrors `vtex/client.ts`'s configureVtex/getVtexConfig pattern so the
 * same wiring contract works across commerce apps. Sites should call
 * `configureMagento(...)` once from their setup phase before any
 * loader/action runs; loaders consume `getMagentoConfig()` to pick up
 * baseUrl, auth, and feature toggles.
 *
 * Two reasons we don't pass config explicitly to every loader:
 *  1. CMS-resolved loader instances don't know where the config block
 *     lives; the site's `initMagentoFromBlocks(blocks)` adapter is the
 *     single source of truth.
 *  2. Matches the rest of @decocms/apps so a site touching VTEX and
 *     Magento has consistent muscle memory.
 */

import { withFetchTimeout } from "@decocms/blocks/sdk/fetchTimeout";

const timeoutFetch = withFetchTimeout();

// ---------------------------------------------------------------------------
// Config shapes
// ---------------------------------------------------------------------------

/**
 * URL-search-param filter mapping consumed by GraphQL product loaders.
 * Each entry pairs a Magento attribute slug (`value`) with the
 * comparison operator the storefront's URL filters use (`type`). The
 * default mapping lives in `utils/constants.ts:DEFAULT_GRAPHQL_FILTERS`;
 * sites extend it via the `customFilters` prop on PLP/list loaders.
 */
export interface FiltersGraphQL {
	value: string;
	type: "EQUAL" | "MATCH" | "RANGE";
}

export interface MagentoFeatures {
	dangerouslyDisableWishlist?: boolean;
	dangerouslyDisableOnLoadUpdate?: boolean;
	dangerouslyReturnNullAfterAction?: boolean;
	dangerouslyDontReturnCartAfterAction?: boolean;
	dangerouslyDisableOnVisibilityChangeUpdate?: boolean;
}

export interface MagentoImagesConfig {
	imagesQtd: number;
	imagesUrl: string;
}

export interface MagentoPricingConfig {
	maxInstallments: number;
	minInstallmentValue: number;
}

export interface MagentoCartConfigs {
	countProductImageInCart?: number;
	changeCardIdAfterCheckout?: boolean;
	cartErrorMessages?: string[];
}

export interface MagentoConfig {
	/** Magento storefront base URL, e.g. `https://loja.granado.com.br/` */
	baseUrl: string;
	/** Bearer token for `Authorization` header on admin REST calls */
	apiKey: string;
	/** Store ID used in headers + path prefixes */
	storeId: number;
	/** Site/site-code used in path segments */
	site: string;
	/** Which Store header to send (default: "site") */
	storeHeader?: string;
	/** Optional opaque header value sent as `x-origin-header` */
	originHeader?: string;
	/** Currency code (e.g. "BRL") */
	currencyCode?: string;
	/** Whether to append `_suffix` to admin endpoints */
	useSuffix?: boolean;
	/** Behavior toggles surfaced to client hooks */
	features?: MagentoFeatures;
	/** Cart-specific tunables */
	cartConfigs?: MagentoCartConfigs;
	/** Images CDN config */
	imagesConfig?: MagentoImagesConfig;
	/** Pricing rules for installments display */
	pricingConfig?: MagentoPricingConfig;
}

// ---------------------------------------------------------------------------
// Module-global state
// ---------------------------------------------------------------------------

let config: MagentoConfig | null = null;

export function configureMagento(c: MagentoConfig): void {
	config = c;
}

export function getMagentoConfig(): MagentoConfig {
	if (!config) {
		throw new Error(
			"[Magento] configureMagento() must be called before loaders run. " +
				"Wire it in your site's setup, e.g. configureMagento(blocks.magento).",
		);
	}
	return config;
}

/**
 * Best-effort init from a CMS block — mirrors `initVtexFromBlocks`.
 *
 * Resolves secret references stored in the CMS block (`apiKey`,
 * `originHeader`) in this priority:
 *   1. Plain string                                              (dev override)
 *   2. `{ get: () => string }` object                            (legacy)
 *   3. `{ encrypted: "<hex>" }` decrypted via `DECO_CRYPTO_KEY`   (prod)
 *   4. `{ name: "ENV_VAR" }` → `process.env[name]`               (fallback)
 *
 * (3) is what the production Deco CMS actually stores — admin
 * encrypts the secret with the site's `DECO_CRYPTO_KEY` so the value
 * never leaves the worker in plain text. Previously this init only
 * read `process.env[name]`, which silently produced `apiKey: ""` for
 * any site that hadn't *also* set the named env var as a CF Worker
 * secret. Result: `Authorization: Bearer ` header missing on every
 * request → Magento 401 → minicart/cart-related loaders dead. The
 * shared `resolveSecret` helper from `@decocms/blocks/sdk/crypto`
 * handles the full chain, matching how VTEX and Shopify configure
 * themselves.
 *
 * Because the AES-CBC decrypt step is async, this function is now
 * `Promise<void>` — site setups must `await` the call before any
 * loader fires.
 */
export async function initMagentoFromBlocks(blocks: Record<string, unknown>): Promise<void> {
	// Lazy-imported to keep `@decocms/blocks/sdk/crypto` out of the
	// import graph for sites that wire Magento manually via
	// `configureMagento({ apiKey: "..." })` without ever calling this
	// helper (e.g. unit tests, CLI tools).
	const { resolveSecret } = await import("@decocms/blocks/sdk/crypto");

	const block = blocks.magento as Record<string, any> | undefined;
	if (!block) {
		console.warn("[Magento] No `magento` block found in CMS; skipping init.");
		return;
	}

	const apiConfig = block.apiConfig ?? {};

	// The env-var fallback names match the Secret block's `name` field
	// when present. `resolveSecret` cycles through the chain documented
	// above; an empty string here means every layer was empty, which we
	// pass through verbatim so `buildHeaders` can detect it.
	const extractEnvName = (value: unknown): string => {
		if (value && typeof value === "object") {
			const name = (value as { name?: unknown }).name;
			if (typeof name === "string") return name;
		}
		return "";
	};
	const apiKeyEnvName = extractEnvName(apiConfig.apiKey);
	const originHeaderEnvName = extractEnvName(apiConfig.originHeader);

	const apiKey = (await resolveSecret(apiConfig.apiKey, apiKeyEnvName)) ?? "";
	const originHeader = (await resolveSecret(apiConfig.originHeader, originHeaderEnvName)) ?? "";

	configureMagento({
		baseUrl: apiConfig.baseUrl ?? "",
		apiKey,
		storeId: apiConfig.storeId ?? 1,
		site: apiConfig.site ?? "",
		storeHeader: apiConfig.storeHeader,
		originHeader,
		currencyCode: apiConfig.currencyCode,
		useSuffix: apiConfig.useSuffix,
		features: block.features,
		cartConfigs: block.cartConfigs,
		imagesConfig: block.imagesConfig,
		pricingConfig: block.pricingConfig,
	});
}

// ---------------------------------------------------------------------------
// HTTP helpers (thin wrappers over fetch with auth pre-applied)
// ---------------------------------------------------------------------------

export interface MagentoFetchOpts extends RequestInit {
	/** Whether to attach the admin Bearer token. Default true. */
	authenticated?: boolean;
}

function buildHeaders(
	opts: MagentoFetchOpts,
	c: MagentoConfig,
	attachMagentoIdentity: boolean,
): Headers {
	const headers = new Headers(opts.headers ?? {});
	// `attachMagentoIdentity` is false when the request is going to a host
	// that isn't the configured Magento backend. None of the Magento-only
	// headers below should leak in that case: the Bearer is privileged, the
	// `x-origin-header` is a secret that third parties shouldn't see, and a
	// forced `Referer` would broadcast our Magento storefront URL.
	if (!attachMagentoIdentity) return headers;

	if (opts.authenticated !== false && c.apiKey) {
		headers.set("Authorization", `Bearer ${c.apiKey}`);
	}
	if (c.originHeader) {
		headers.set("x-origin-header", c.originHeader);
	}
	if (!headers.has("Referer")) {
		headers.set("Referer", c.baseUrl);
	}
	return headers;
}

export function magentoFetch(path: string, opts: MagentoFetchOpts = {}): Promise<Response> {
	const c = getMagentoConfig();
	const baseUrl = new URL(c.baseUrl);
	const target = path.startsWith("http")
		? new URL(path)
		: new URL(path.startsWith("/") ? path : `/${path}`, baseUrl);

	// Only attach Magento identity (Bearer, x-origin-header, forced Referer)
	// when the request is going to the configured Magento host. An absolute
	// URL to a different origin would otherwise leak the admin token *and*
	// our origin/Referer secrets to that third party. Callers that genuinely
	// want a third-party call must still pass `authenticated: false` for
	// clarity at the call site.
	const sameOrigin = target.origin === baseUrl.origin;

	return timeoutFetch(target, { ...opts, headers: buildHeaders(opts, c, sameOrigin) });
}
