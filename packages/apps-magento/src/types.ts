/**
 * Shared types for the Magento app — kept minimal in this initial port.
 * Loader/action ports should extend this file rather than duplicating
 * inline types.
 */
import type { MagentoFeatures } from "./client";

export interface MagentoCart {
	id: string | null;
	items: MagentoCartItem[];
	totals?: {
		subtotal?: number;
		grand_total?: number;
		discount_amount?: number;
		shipping_amount?: number;
	};
	coupon_code?: string | null;
}

export interface MagentoCartItem {
	item_id: number;
	sku: string;
	name?: string;
	qty: number;
	price?: number;
	row_total?: number;
}

export type Features = MagentoFeatures;

/**
 * Magento newsletter subscription response shape — what
 * `actions/newsletter/subscribe` returns to the storefront.
 */
export interface NewsletterData {
	success: boolean;
	message: string;
}

/**
 * Stock-alert mutation response from Magento's GraphQL endpoint —
 * `actions/product/stockAlert` returns this (or `{ error }`).
 */
export interface ProductStockAlertResponse {
	data?: {
		productStockAlert: {
			message: string;
			status: boolean;
		};
	};
}
