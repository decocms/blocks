/**
 * VTEX Checkout API actions.
 * Each function receives a single props object — matching the invoke handler
 * pattern from deco-cx/apps where `setupApps()` registers handlers directly.
 *
 * Ported from deco-cx/apps vtex/actions/cart/*.ts
 * @see https://developers.vtex.com/docs/api-reference/checkout-api
 */

import { getVtexConfig, vtexFetchWithCookies } from "../client";
import type { OrderForm } from "../types";

export const DEFAULT_EXPECTED_SECTIONS = [
	"items",
	"totalizers",
	"clientProfileData",
	"shippingData",
	"paymentData",
	"sellers",
	"messages",
	"marketingData",
	"clientPreferencesData",
	"storePreferencesData",
	"giftRegistryData",
	"ratesAndBenefitsData",
	"openTextField",
	"commercialConditionData",
	"customData",
];

function scParam(): string {
	const sc = getVtexConfig().salesChannel;
	return sc ? `sc=${sc}` : "";
}

function appendSc(params: URLSearchParams): URLSearchParams {
	const sc = getVtexConfig().salesChannel;
	if (sc) params.set("sc", sc);
	return params;
}

function forceHttpsOnAssets(orderForm: OrderForm): OrderForm {
	if (!orderForm?.items) return orderForm;
	return {
		...orderForm,
		items: orderForm.items.map((item: any) => ({
			...item,
			imageUrl: item.imageUrl?.replace(/^http:/, "https:"),
		})),
	};
}

// ---------------------------------------------------------------------------
// Cart (OrderForm) — core CRUD
// ---------------------------------------------------------------------------

export interface GetOrCreateCartProps {
	orderFormId?: string;
}

export async function getOrCreateCart(props: GetOrCreateCartProps): Promise<OrderForm> {
	const { orderFormId } = props;
	const sc = scParam();

	if (orderFormId) {
		const result = await vtexFetchWithCookies<OrderForm>(
			`/api/checkout/pub/orderForm/${orderFormId}${sc ? `?${sc}` : ""}`,
		);
		return forceHttpsOnAssets(result);
	}
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm${sc ? `?${sc}` : ""}`,
		{
			method: "POST",
			body: JSON.stringify({
				expectedOrderFormSections: DEFAULT_EXPECTED_SECTIONS,
			}),
		},
	);
	return forceHttpsOnAssets(result);
}

export interface AddItemsToCartProps {
	orderFormId: string;
	orderItems: Array<{
		id: string;
		seller: string;
		quantity: number;
		index?: number;
		price?: number;
	}>;
	allowedOutdatedData?: string[];
}

export async function addItemsToCart(props: AddItemsToCartProps): Promise<OrderForm> {
	const { orderFormId, orderItems, allowedOutdatedData = ["paymentData"] } = props;
	const params = appendSc(new URLSearchParams());
	for (const d of allowedOutdatedData) params.append("allowedOutdatedData", d);
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/items?${params}`,
		{ method: "POST", body: JSON.stringify({ orderItems }) },
	);
	return forceHttpsOnAssets(result);
}

export interface UpdateCartItemsProps {
	orderFormId: string;
	orderItems: Array<{ index: number; quantity: number }>;
	allowedOutdatedData?: string[];
	noSplitItem?: boolean;
}

export async function updateCartItems(props: UpdateCartItemsProps): Promise<OrderForm> {
	const { orderFormId, orderItems, allowedOutdatedData = ["paymentData"], noSplitItem } = props;
	const params = appendSc(new URLSearchParams());
	for (const d of allowedOutdatedData) {
		params.append("allowedOutdatedData", d);
	}
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/items/update?${params}`,
		{
			method: "POST",
			body: JSON.stringify({
				orderItems,
				noSplitItem: Boolean(noSplitItem),
			}),
		},
	);
	return forceHttpsOnAssets(result);
}

export interface RemoveAllItemsProps {
	orderFormId: string;
}

export async function removeAllItems(props: RemoveAllItemsProps): Promise<OrderForm> {
	const { orderFormId } = props;
	const sc = scParam();
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/items/removeAll${sc ? `?${sc}` : ""}`,
		{ method: "POST", body: JSON.stringify({}) },
	);
	return forceHttpsOnAssets(result);
}

export interface AddCouponToCartProps {
	orderFormId: string;
	text: string;
}

export async function addCouponToCart(props: AddCouponToCartProps): Promise<OrderForm> {
	const { orderFormId, text } = props;
	const sc = scParam();
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/coupons${sc ? `?${sc}` : ""}`,
		{ method: "POST", body: JSON.stringify({ text }) },
	);
	return forceHttpsOnAssets(result);
}

// ---------------------------------------------------------------------------
// Cart — simulation
// ---------------------------------------------------------------------------

export interface SimulationItem {
	id: number | string;
	quantity: number;
	seller: string;
}

export interface SimulateCartProps {
	items: SimulationItem[];
	postalCode: string;
	country?: string;
	RnbBehavior?: 0 | 1;
}

export async function simulateCart(props: SimulateCartProps) {
	const { items, postalCode, country, RnbBehavior = 1 } = props;
	const config = getVtexConfig();
	const params = appendSc(new URLSearchParams({ RnbBehavior: String(RnbBehavior) }));
	// Uses vtexFetchWithCookies so any Set-Cookie VTEX returns on the
	// orderForm-scoped simulation reaches the browser via RequestContext.
	// Without this, the segment/ownership cookies VTEX may rotate during
	// simulation are dropped, and the storefront's local orderFormId
	// drifts away from VTEX's checkout.vtex.com server cookie.
	return vtexFetchWithCookies<any>(`/api/checkout/pub/orderForms/simulation?${params}`, {
		method: "POST",
		body: JSON.stringify({
			items,
			postalCode,
			country: country ?? config.country ?? "BRA",
		}),
	});
}

// ---------------------------------------------------------------------------
// Cart — offerings (services attached to items)
// ---------------------------------------------------------------------------

export interface AddOfferingProps {
	orderFormId: string;
	itemIndex: number;
	offeringId: string | number;
	expectedOrderFormSections?: string[];
}

export async function addOffering(props: AddOfferingProps): Promise<OrderForm> {
	const {
		orderFormId,
		itemIndex,
		offeringId,
		expectedOrderFormSections = DEFAULT_EXPECTED_SECTIONS,
	} = props;
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/items/${itemIndex}/offerings`,
		{
			method: "POST",
			body: JSON.stringify({
				expectedOrderFormSections,
				id: offeringId,
				info: null,
			}),
		},
	);
	return forceHttpsOnAssets(result);
}

export interface RemoveOfferingProps {
	orderFormId: string;
	itemIndex: number;
	offeringId: string | number;
	expectedOrderFormSections?: string[];
}

export async function removeOffering(props: RemoveOfferingProps): Promise<OrderForm> {
	const {
		orderFormId,
		itemIndex,
		offeringId,
		expectedOrderFormSections = DEFAULT_EXPECTED_SECTIONS,
	} = props;
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/items/${itemIndex}/offerings/${offeringId}/remove`,
		{
			method: "POST",
			body: JSON.stringify({ expectedOrderFormSections }),
		},
	);
	return forceHttpsOnAssets(result);
}

// ---------------------------------------------------------------------------
// Cart — attachments
// ---------------------------------------------------------------------------

export interface UpdateOrderFormAttachmentProps {
	orderFormId: string;
	attachment: string;
	body: Record<string, unknown>;
	expectedOrderFormSections?: string[];
}

export async function updateOrderFormAttachment(
	props: UpdateOrderFormAttachmentProps,
): Promise<OrderForm> {
	const {
		orderFormId,
		attachment,
		body,
		expectedOrderFormSections = DEFAULT_EXPECTED_SECTIONS,
	} = props;
	if (!orderFormId) throw new Error("Order form ID is required");
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/attachments/${attachment}`,
		{
			method: "POST",
			body: JSON.stringify({ expectedOrderFormSections, ...body }),
		},
	);
	return forceHttpsOnAssets(result);
}

export interface UpdateItemAttachmentProps {
	orderFormId: string;
	itemIndex: number;
	attachment: string;
	content: Record<string, unknown>;
	noSplitItem?: boolean;
	expectedOrderFormSections?: string[];
}

export async function updateItemAttachment(props: UpdateItemAttachmentProps): Promise<OrderForm> {
	const {
		orderFormId,
		itemIndex,
		attachment,
		content,
		noSplitItem = true,
		expectedOrderFormSections = DEFAULT_EXPECTED_SECTIONS,
	} = props;
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/items/${itemIndex}/attachments/${attachment}`,
		{
			method: "POST",
			body: JSON.stringify({
				content,
				noSplitItem,
				expectedOrderFormSections,
			}),
		},
	);
	return forceHttpsOnAssets(result);
}

export interface RemoveItemAttachmentProps {
	orderFormId: string;
	itemIndex: number;
	attachment: string;
	content: Record<string, unknown>;
	noSplitItem?: boolean;
	expectedOrderFormSections?: string[];
}

export async function removeItemAttachment(props: RemoveItemAttachmentProps): Promise<OrderForm> {
	const {
		orderFormId,
		itemIndex,
		attachment,
		content,
		noSplitItem = true,
		expectedOrderFormSections = DEFAULT_EXPECTED_SECTIONS,
	} = props;
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/items/${itemIndex}/attachments/${attachment}`,
		{
			method: "DELETE",
			body: JSON.stringify({
				content,
				noSplitItem,
				expectedOrderFormSections,
			}),
		},
	);
	return forceHttpsOnAssets(result);
}

// ---------------------------------------------------------------------------
// Cart — price override
// ---------------------------------------------------------------------------

export interface UpdateItemPriceProps {
	orderFormId: string;
	itemIndex: number;
	price: number;
}

export async function updateItemPrice(props: UpdateItemPriceProps): Promise<OrderForm> {
	const { orderFormId, itemIndex, price } = props;
	return vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/items/${itemIndex}/price`,
		{ method: "PUT", body: JSON.stringify({ price }) },
	);
}

// ---------------------------------------------------------------------------
// Cart — selectable gifts
// ---------------------------------------------------------------------------

export interface UpdateSelectableGiftsProps {
	orderFormId: string;
	giftId: string;
	selectedGifts: Array<{ id: string; seller: string; quantity: number }>;
	expectedOrderFormSections?: string[];
}

export async function updateSelectableGifts(props: UpdateSelectableGiftsProps): Promise<OrderForm> {
	const {
		orderFormId,
		giftId,
		selectedGifts,
		expectedOrderFormSections = DEFAULT_EXPECTED_SECTIONS,
	} = props;
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/selectable-gifts/${giftId}`,
		{
			method: "POST",
			body: JSON.stringify({
				expectedOrderFormSections,
				selectedGifts,
				id: giftId,
			}),
		},
	);
	return forceHttpsOnAssets(result);
}

// ---------------------------------------------------------------------------
// Cart — installments
// ---------------------------------------------------------------------------

export interface GetInstallmentsProps {
	orderFormId: string;
	paymentSystem: number;
}

export async function getInstallments(props: GetInstallmentsProps) {
	const { orderFormId, paymentSystem } = props;
	const params = new URLSearchParams({ paymentSystem: String(paymentSystem) });
	appendSc(params);
	return vtexFetchWithCookies<any>(
		`/api/checkout/pub/orderForm/${orderFormId}/installments?${params}`,
	);
}

// ---------------------------------------------------------------------------
// Cart — profile & messages
// ---------------------------------------------------------------------------

export interface UpdateOrderFormProfileProps {
	orderFormId: string;
	fields: Record<string, unknown>;
	ignoreProfileData?: boolean;
}

export async function updateOrderFormProfile(
	props: UpdateOrderFormProfileProps,
): Promise<OrderForm> {
	const { orderFormId, fields, ignoreProfileData } = props;
	const body = ignoreProfileData ? { ...fields, ignoreProfileData: true } : fields;
	const result = await vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/profile`,
		{ method: "PATCH", body: JSON.stringify(body) },
	);
	return forceHttpsOnAssets(result);
}

export interface ChangeToAnonymousUserProps {
	orderFormId: string;
}

export async function changeToAnonymousUser(props: ChangeToAnonymousUserProps): Promise<OrderForm> {
	const { orderFormId } = props;
	// This endpoint rotates the orderForm ownership cookies — must use
	// vtexFetchWithCookies so the new cookies reach the browser.
	return vtexFetchWithCookies<OrderForm>(`/api/checkout/changeToAnonymousUser/${orderFormId}`);
}

export interface ClearOrderFormMessagesProps {
	orderFormId: string;
}

export async function clearOrderFormMessages(
	props: ClearOrderFormMessagesProps,
): Promise<OrderForm> {
	const { orderFormId } = props;
	return vtexFetchWithCookies<OrderForm>(
		`/api/checkout/pub/orderForm/${orderFormId}/messages/clear`,
		{
			method: "POST",
			body: JSON.stringify({}),
		},
	);
}

// ---------------------------------------------------------------------------
// Shipping / Regions
// ---------------------------------------------------------------------------

export interface Seller {
	id: string;
	name: string;
}

export interface RegionResult {
	id: string;
	sellers: Seller[];
}

export interface GetSellersByRegionProps {
	postalCode: string;
	salesChannel?: string;
}

export async function getSellersByRegion(
	props: GetSellersByRegionProps,
): Promise<RegionResult | null> {
	const { postalCode, salesChannel } = props;
	const params = new URLSearchParams({ country: "BRA", postalCode });
	const sc = salesChannel ?? getVtexConfig().salesChannel;
	if (sc) params.set("sc", sc);
	const resp = await vtexFetchWithCookies<RegionResult[]>(`/api/checkout/pub/regions/?${params}`);
	return resp[0]?.sellers?.length > 0 ? resp[0] : null;
}

export interface SetShippingPostalCodeProps {
	orderFormId: string;
	postalCode: string;
	country?: string;
}

export async function setShippingPostalCode(props: SetShippingPostalCodeProps): Promise<boolean> {
	const { orderFormId, postalCode, country = "BRA" } = props;
	try {
		// VTEX docs note that /attachments/shippingData can rotate the
		// CheckoutOrderFormOwnership cookie. vtexFetchWithCookies ensures
		// any such Set-Cookie reaches the browser via RequestContext,
		// keeping the storefront and VTEX bound to the same orderForm.
		await vtexFetchWithCookies<any>(
			`/api/checkout/pub/orderForm/${orderFormId}/attachments/shippingData`,
			{
				method: "POST",
				body: JSON.stringify({
					selectedAddresses: [{ postalCode, country }],
				}),
			},
		);
		return true;
	} catch {
		return false;
	}
}
