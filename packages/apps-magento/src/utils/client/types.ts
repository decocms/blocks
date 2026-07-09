/**
 * Magento REST API response shapes — the subset of types from
 * `deco-cx/apps/magento/utils/client/types.ts` that the port has
 * reached so far. Extended as more loaders/actions land.
 *
 * Keep field names **exactly** as Magento returns them (mostly
 * snake_case, occasional camelCase from carbono-customer). Consumer
 * sites already render against these shapes — any rename is a
 * breaking change at the storefront, not just the API boundary.
 */

// ---------------------------------------------------------------------------
// Customer / user section payloads (added by the user+wishlist port)
// ---------------------------------------------------------------------------

/**
 * `customer` slice of `/customer/section/load?sections=customer,…`.
 * Magento returns this on every authenticated section call.
 */
export interface Customer {
	data_id: number;
	fullname?: string;
	firstname?: string;
}

/**
 * `carbono-customer` slice. Granado-specific overlay that mirrors the
 * `customer` slice plus a website/store id pair and a normalized email.
 * Other magento sites that don't run the Carbono module will get this
 * absent; loaders/user.ts checks for it before mapping to a Person.
 */
export interface CarbonoCustomer {
	websiteId?: string;
	email?: string;
	customerId?: string;
	data_id: number;
}

/**
 * `cart` slice of the customer section bundle — minimal projection of
 * the cart that the minicart island renders before the full cart loader
 * has resolved. Not the same as the full Cart payload from
 * `/V1/carts/:cartId` (which lives in MagentoCart in types.ts).
 */
export interface CartUser {
	summary_count: number;
	subtotalAmount: number | null;
	subtotal: string;
	possible_onepage_checkout: boolean;
	items: [];
	isGuestCheckoutAllowed: boolean;
	website_id: string;
	storeId: string;
	adyen_payment_methods: unknown[];
	extra_actions: string;
	cart_empty_message: string;
	subtotal_incl_tax: string;
	subtotal_excl_tax: string;
	mpFSBCartTotal: unknown | null;
	data_id: number;
	minicart_improvements: MinicartImprovements;
}

export interface MinicartImprovements {
	coupon_code: string | null;
	country_id: string;
	api_base_url: string;
	is_logged_in: boolean;
	quote_id: string;
	base_url: string;
}

/**
 * Bundle shape returned by
 * `GET /:site/customer/section/load?sections=customer,carbono-customer,wishlist,…`.
 * Keys are optional because the caller picks which sections to request.
 */
export interface CustomerSectionLoad {
	customer?: Customer;
	"carbono-customer"?: CarbonoCustomer;
	cart?: CartUser;
	wishlist?: Wishlist;
}

// ---------------------------------------------------------------------------
// Wishlist payloads
// ---------------------------------------------------------------------------

export interface Wishlist {
	counter: string;
	items: WishlistItem[];
	counter_number: number;
	data_id: number;
}

export interface WishlistItem {
	image: WishlistItemImage;
	product_sku: string;
	product_id: string;
	product_url: string;
	product_name: string;
	product_price: string;
	product_is_saleable_and_visible: boolean;
	product_has_required_options: boolean;
	add_to_cart_params: string;
	delete_item_params: string;
}

export interface WishlistItemImage {
	template: string;
	src: string;
	width: number;
	height: number;
	alt: string;
}

// ---------------------------------------------------------------------------
// Shared attribute/category shapes (added by the transform port)
// ---------------------------------------------------------------------------

export interface CustomAttribute {
	attribute_code: string;
	value: string | string[];
}

export interface CategoryLink {
	position: number;
	category_id: string;
}

export interface MagentoCategory {
	id: number;
	parent_id: number;
	name: string;
	is_active: boolean;
	position: number;
	level: number;
	children: string;
	created_at: string;
	updated_at: string;
	path: string;
	include_in_menu: boolean;
	custom_attributes: CustomAttribute[];
}

// ---------------------------------------------------------------------------
// Product detail shapes (used by PDP / PLP / list loaders)
// ---------------------------------------------------------------------------

export interface MagentoPriceInfo {
	final_price: number;
	max_price: number;
	max_regular_price: number;
	minimal_regular_price: number;
	special_price: number | null;
	minimal_price: number;
	regular_price: number;
	formatted_prices: {
		final_price: string;
		max_price: string;
		minimal_price: string;
		max_regular_price: string;
		minimal_regular_price: string | null;
		special_price: string | null;
		regular_price: string;
	};
	extension_attributes: {
		msrp: {
			msrp_price: string;
			is_applicable: string;
			is_shown_price_on_gesture: string;
			msrp_message: string;
			explanation_message: string;
		};
		tax_adjustments: {
			final_price: number;
			max_price: number;
			max_regular_price: number;
			minimal_regular_price: number;
			special_price: number;
			minimal_price: number;
			regular_price: number;
			formatted_prices: {
				final_price: string;
				max_price: string;
				minimal_price: string;
				max_regular_price: string;
				minimal_regular_price: string | null;
				special_price: string;
				regular_price: string;
			};
		};
		weee_attributes: unknown[];
		weee_adjustment: string;
	};
}

export interface MagentoStock {
	item_id: number;
	product_id: number;
	stock_id: number;
	qty?: number;
	is_in_stock?: boolean;
	is_qty_decimal?: boolean;
	show_default_notification_message?: boolean;
	use_config_min_qty?: boolean;
	min_qty?: number;
	use_config_min_sale_qty?: boolean;
	min_sale_qty?: number;
	use_config_max_sale_qty?: boolean;
	max_sale_qty?: number;
	use_config_backorders?: boolean;
	backorders?: number;
	use_config_notify_stock_qty?: boolean;
	notify_stock_qty?: number;
	use_config_qty_increments?: boolean;
	qty_increments?: number;
	use_config_enable_qty_inc?: boolean;
	enable_qty_increments?: boolean;
	use_config_manage_stock?: boolean;
	manage_stock?: boolean;
	low_stock_date?: string | null;
	is_decimal_divided?: boolean;
	stock_status_changed_auto?: number;
}

export interface MagentoImage {
	url: string;
	code: string;
	height: number;
	width: number;
	label: string;
	resized_width: number;
	resized_height: number;
	disabled: boolean;
}

export interface MediaEntry {
	id: number;
	media_type: string;
	label: string | null;
	position: number;
	disabled: boolean;
	types: string[];
	file: string;
}

export interface MagentoProduct {
	id: number;
	sku: string;
	name: string;
	price: number;
	status: number;
	visibility: number;
	type_id: string;
	created_at: string;
	updated_at: string;
	weight: number;
	url: string;
	extension_attributes: {
		website_ids?: number[];
		category_links: CategoryLink[];
		stock_item?: MagentoStock;
	};
	custom_attributes: CustomAttribute[];
	price_info?: MagentoPriceInfo;
	currency_code?: string;
	images?: MagentoImage[];
	media_gallery_entries?: MediaEntry[];
}
