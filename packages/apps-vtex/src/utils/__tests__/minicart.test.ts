import { describe, expect, it } from "vitest";
import type { OrderForm, OrderFormItem, Totalizer } from "../../types";
import { vtexOrderFormToMinicart } from "../minicart";

const baseStorePreferences = {
	countryCode: "BRA",
	currencyCode: "BRL",
	currencyLocale: 1046,
	currencySymbol: "R$",
	saveUserData: true,
	timeZone: "E. South America Standard Time",
	currencyFormatInfo: {
		currencyDecimalDigits: 2,
		currencyDecimalSeparator: ",",
		currencyGroupSeparator: ".",
		currencyGroupSize: 3,
		startsWithCurrencySymbol: true,
	},
};

function makeOrderForm(overrides: Partial<OrderForm> = {}): OrderForm {
	return {
		orderFormId: "of-1",
		salesChannel: "1",
		loggedIn: false,
		isCheckedIn: false,
		allowManualPrice: false,
		canEditData: false,
		ignoreProfileData: false,
		value: 0,
		messages: [],
		items: [],
		totalizers: [],
		shippingData: null,
		clientProfileData: null,
		paymentData: null,
		marketingData: null,
		sellers: [],
		clientPreferencesData: { locale: "pt-BR" },
		storePreferencesData: baseStorePreferences,
		...overrides,
	};
}

function makeItem(overrides: Partial<OrderFormItem> = {}): OrderFormItem {
	return {
		uniqueId: "uid-1",
		id: "sku-1",
		productId: "p-1",
		name: "T-Shirt",
		skuName: "T-Shirt M",
		price: 9990,
		listPrice: 12990,
		sellingPrice: 9990,
		quantity: 2,
		seller: "1",
		imageUrl: "http://example.com/img.jpg",
		detailUrl: "/p/t-shirt",
		additionalInfo: { brandName: "Brand", brandId: "b-1" },
		productCategoryIds: "/123/",
		productCategories: { "123": "Clothing" },
		availability: "available",
		measurementUnit: "un",
		unitMultiplier: 1,
		...overrides,
	};
}

function tot(id: string, value: number, name = id): Totalizer {
	return { id, name, value };
}

describe("vtexOrderFormToMinicart", () => {
	it("returns an empty cart shape for an empty OrderForm", () => {
		const minicart = vtexOrderFormToMinicart(makeOrderForm());
		expect(minicart.storefront.items).toEqual([]);
		expect(minicart.storefront.subtotal).toBe(0);
		expect(minicart.storefront.discounts).toBe(0);
		expect(minicart.storefront.total).toBe(0);
		expect(minicart.storefront.shipping).toBeUndefined();
	});

	it("converts cents to major units across totalizers", () => {
		const orderForm = makeOrderForm({
			value: 19980,
			totalizers: [tot("Items", 25980), tot("Discounts", -6000), tot("Shipping", 1500)],
			items: [makeItem()],
		});
		const minicart = vtexOrderFormToMinicart(orderForm);
		expect(minicart.storefront.subtotal).toBeCloseTo(259.8, 2);
		expect(minicart.storefront.discounts).toBeCloseTo(60, 2);
		expect(minicart.storefront.shipping).toBeCloseTo(15, 2);
		expect(minicart.storefront.total).toBeCloseTo(199.8, 2);
	});

	it("Discounts are always non-negative even when VTEX returns a negative totalizer", () => {
		const orderForm = makeOrderForm({
			value: 9990,
			totalizers: [tot("Items", 9990), tot("Discounts", -1000)],
			items: [makeItem()],
		});
		const minicart = vtexOrderFormToMinicart(orderForm);
		expect(minicart.storefront.discounts).toBe(10);
	});

	it("omits shipping when no Shipping totalizer is present", () => {
		const orderForm = makeOrderForm({
			value: 9990,
			totalizers: [tot("Items", 9990)],
			items: [makeItem()],
		});
		const minicart = vtexOrderFormToMinicart(orderForm);
		expect(minicart.storefront.shipping).toBeUndefined();
	});

	it("maps OrderFormItem to MinicartItem with major-unit prices and analytics fields", () => {
		const orderForm = makeOrderForm({
			value: 19980,
			totalizers: [tot("Items", 19980)],
			items: [makeItem()],
		});
		const minicart = vtexOrderFormToMinicart(orderForm);
		const item = minicart.storefront.items[0];
		expect(item.item_id).toBe("sku-1");
		expect(item.item_group_id).toBe("p-1");
		expect(item.item_name).toBe("T-Shirt");
		expect(item.item_brand).toBe("Brand");
		expect(item.item_url).toBe("/p/t-shirt");
		expect(item.price).toBeCloseTo(99.9, 2);
		expect(item.listPrice).toBeCloseTo(129.9, 2);
		expect(item.discount).toBeCloseTo(30, 2);
		expect(item.quantity).toBe(2);
		expect(item.seller).toBe("1");
		expect(item.affiliation).toBe("1");
	});

	it("forces https on item images", () => {
		const orderForm = makeOrderForm({
			items: [makeItem({ imageUrl: "http://cdn.example.com/img.jpg" })],
		});
		const minicart = vtexOrderFormToMinicart(orderForm);
		expect(minicart.storefront.items[0].image).toBe("https://cdn.example.com/img.jpg");
	});

	it("propagates the marketing coupon onto every item and the storefront root", () => {
		const orderForm = makeOrderForm({
			items: [makeItem(), makeItem({ uniqueId: "uid-2", id: "sku-2" })],
			marketingData: { coupon: "SAVE10" },
		});
		const minicart = vtexOrderFormToMinicart(orderForm);
		expect(minicart.storefront.coupon).toBe("SAVE10");
		expect(minicart.storefront.items[0].coupon).toBe("SAVE10");
		expect(minicart.storefront.items[1].coupon).toBe("SAVE10");
	});

	it("uses opts overrides for free-shipping target, locale, checkout href and coupon toggle", () => {
		const minicart = vtexOrderFormToMinicart(makeOrderForm(), {
			freeShippingTarget: 250,
			locale: "en-US",
			checkoutHref: "/cart/go",
			enableCoupon: false,
		});
		expect(minicart.storefront.freeShippingTarget).toBe(250);
		expect(minicart.storefront.locale).toBe("en-US");
		expect(minicart.storefront.checkoutHref).toBe("/cart/go");
		expect(minicart.storefront.enableCoupon).toBe(false);
	});

	it("infers pt-BR locale from BRA countryCode when no override is given", () => {
		const orderForm = makeOrderForm({
			clientPreferencesData: { locale: "" },
			storePreferencesData: { ...baseStorePreferences, countryCode: "BRA" },
		});
		const minicart = vtexOrderFormToMinicart(orderForm);
		expect(minicart.storefront.locale).toBe("pt-BR");
	});

	it("preserves the raw OrderForm under .original for site escape hatches", () => {
		const orderForm = makeOrderForm({ orderFormId: "of-original" });
		const minicart = vtexOrderFormToMinicart(orderForm);
		expect(minicart.original).toBe(orderForm);
		expect(minicart.original.orderFormId).toBe("of-original");
	});
});
