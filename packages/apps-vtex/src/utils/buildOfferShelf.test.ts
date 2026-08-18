import { describe, expect, it } from "vitest";
import type { AggregateOffer, Offer, UnitPriceSpecification } from "@decocms/apps-commerce/types";
import { useOffer } from "@decocms/apps-commerce/sdk/useOffer";
import { buildOfferShelf } from "./transform";

const installment = (
	over: Partial<UnitPriceSpecification>,
): UnitPriceSpecification =>
	({
		"@type": "UnitPriceSpecification",
		priceType: "https://schema.org/SalePrice",
		priceComponentType: "https://schema.org/Installment",
		...over,
	}) as UnitPriceSpecification;

const offerWith = (specs: UnitPriceSpecification[]): Offer =>
	({
		"@type": "Offer",
		price: 100,
		priceSpecification: [
			{ "@type": "UnitPriceSpecification", priceType: "https://schema.org/ListPrice", price: 120 },
			{ "@type": "UnitPriceSpecification", priceType: "https://schema.org/SalePrice", price: 100 },
			...specs,
		],
	}) as Offer;

const pickInstallment = (offer: Offer) =>
	useOffer({ "@type": "AggregateOffer", offers: [offer] } as AggregateOffer).installment;

describe("buildOfferShelf installment selection", () => {
	it("keeps the same installment useOffer picks on PLP/PDP (shelf == detail)", () => {
		// 12x whose stated total (100) is the lowest and duration the highest, but VTEX
		// rounding makes 12 * 8.34 = 100.08 — the old 1-cent isNoInterest check rejected
		// it and the shelf fell back to 10x, diverging from the detail page's 12x.
		const full = offerWith([
			installment({ name: "PIX", billingDuration: 1, billingIncrement: 100, price: 100 }),
			installment({ name: "Visa", billingDuration: 10, billingIncrement: 10, price: 100 }),
			installment({ name: "Visa", billingDuration: 12, billingIncrement: 8.34, price: 100 }),
			installment({ name: "Visa", billingDuration: 6, billingIncrement: 17.67, price: 106 }),
		]);

		const lean = buildOfferShelf(full);

		expect(pickInstallment(lean)).toEqual(pickInstallment(full));
		expect(pickInstallment(lean)?.billingDuration).toBe(12);
	});

	it("keeps the lowest-total plan even when every installment has interest", () => {
		const full = offerWith([
			installment({ name: "Visa", billingDuration: 3, billingIncrement: 34, price: 102 }),
			installment({ name: "Visa", billingDuration: 6, billingIncrement: 18, price: 108 }),
		]);

		const lean = buildOfferShelf(full);

		expect(pickInstallment(lean)).toEqual(pickInstallment(full));
		expect(pickInstallment(lean)?.price).toBe(102);
	});
});
