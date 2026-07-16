/**
 * Tests for `projectOrderForm` — the server-side fragmentation of a VTEX
 * OrderForm into the requested `CartProjection`. Pure function, no I/O.
 */

import type { Minicart } from "@decocms/apps-commerce/types";
import { describe, expect, it } from "vitest";
import type { OrderForm } from "../../types";
import { projectOrderForm } from "../cartProjection";

function makeOrderForm(overrides: Partial<OrderForm> = {}): OrderForm {
  return {
    orderFormId: "of-123",
    salesChannel: "1",
    loggedIn: false,
    isCheckedIn: false,
    allowManualPrice: false,
    canEditData: true,
    ignoreProfileData: false,
    value: 15000, // R$150.00 in cents
    messages: [],
    items: [
      {
        id: "sku-1",
        productId: "prod-1",
        name: "Camiseta",
        skuName: "Camiseta P Azul",
        imageUrl: "http://img.example/x.jpg",
        detailUrl: "/camiseta/p",
        price: 10000,
        listPrice: 12000,
        sellingPrice: 10000,
        quantity: 1,
        seller: "1",
        uniqueId: "u1",
      },
      {
        id: "sku-2",
        productId: "prod-2",
        name: "Boné",
        skuName: "Boné U Preto",
        imageUrl: "https://img.example/y.jpg",
        detailUrl: "/bone/u",
        price: 5000,
        listPrice: 5000,
        sellingPrice: 5000,
        quantity: 2,
        seller: "1",
        uniqueId: "u2",
      },
    ],
    totalizers: [
      { id: "Items", name: "Items", value: 20000 },
      { id: "Discounts", name: "Discounts", value: -5000 },
    ],
    shippingData: null,
    clientProfileData: null,
    paymentData: null,
    marketingData: null,
    ...overrides,
  } as OrderForm;
}

describe("projectOrderForm", () => {
  it("none → { ok: true } and discards the payload", () => {
    expect(projectOrderForm(makeOrderForm(), "none")).toEqual({ ok: true });
  });

  it("summary → orderFormId, summed quantities, total in major units", () => {
    const r = projectOrderForm(makeOrderForm(), "summary") as {
      orderFormId: string;
      totalItems: number;
      total: number;
    };
    expect(r.orderFormId).toBe("of-123");
    expect(r.totalItems).toBe(3); // 1 + 2
    expect(r.total).toBe(150); // 15000 cents → 150
  });

  it("summary+items → summary plus slim, https-normalized items", () => {
    const r = projectOrderForm(makeOrderForm(), "summary+items") as {
      totalItems: number;
      items: Array<{ item_name: string; image: string; price: number; quantity: number }>;
    };
    expect(r.totalItems).toBe(3);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      item_name: "Camiseta",
      item_variant: "Camiseta P Azul",
      image: "https://img.example/x.jpg", // http → https
      price: 100, // 10000 cents
      quantity: 1,
    });
    // slim projection must NOT leak the full VTEX item fields
    expect(r.items[0]).not.toHaveProperty("uniqueId");
  });

  it("minicart → canonical Minicart with major-unit totals", () => {
    const r = projectOrderForm(makeOrderForm(), "minicart") as Minicart<OrderForm>;
    expect(r.storefront.items).toHaveLength(2);
    expect(r.storefront.total).toBe(150);
    expect(r.original.orderFormId).toBe("of-123");
  });

  it("raw → the untouched OrderForm", () => {
    const of = makeOrderForm();
    expect(projectOrderForm(of, "raw")).toBe(of);
  });

  it("summary handles an empty cart without NaN", () => {
    const r = projectOrderForm(
      makeOrderForm({ items: [], value: 0, totalizers: [] }),
      "summary",
    ) as { totalItems: number; total: number };
    expect(r.totalItems).toBe(0);
    expect(r.total).toBe(0);
  });
});
