import { configureShopify } from "./client";

let initialized = false;

/**
 * Initialize Shopify from raw block data.
 * The site is responsible for reading the blocks and passing the config here.
 */
export function initShopify(config: { storeName: string; storefrontAccessToken: string }) {
	if (initialized) return;

	if (!config.storeName || !config.storefrontAccessToken) {
		console.warn("[Shopify] Missing storeName or storefrontAccessToken.");
		return;
	}

	console.log(`[Shopify] Initializing: ${config.storeName}.myshopify.com`);
	configureShopify(config);
	initialized = true;
}

/**
 * Initialize Shopify from a blocks map (convenience wrapper).
 * Looks for the "deco-shopify" block and extracts credentials.
 */
export function initShopifyFromBlocks(blocks: Record<string, unknown>) {
	const shopifyBlock = blocks["deco-shopify"] as
		| { storeName: string; storefrontAccessToken: string }
		| undefined;
	if (!shopifyBlock) {
		console.warn("[Shopify] No deco-shopify block found.");
		return;
	}

	initShopify({
		storeName: shopifyBlock.storeName,
		storefrontAccessToken: shopifyBlock.storefrontAccessToken,
	});
}
