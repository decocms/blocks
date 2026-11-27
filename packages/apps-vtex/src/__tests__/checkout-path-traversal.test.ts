/**
 * Regression test for the orderFormId path-traversal → SSRF in checkout actions.
 *
 * Caller-supplied path segments (`orderFormId`, `attachment`, `offeringId`,
 * `giftId`, `itemIndex`) are interpolated into the VTEX request path. Because
 * the client builds the URL with `new URL()` (which collapses `../`), an
 * `orderFormId` such as `../../../dataentities/CL/search?_fields=email#` would
 * otherwise escape `/checkout/pub/` and reach admin endpoints with the store's
 * AppKey/AppToken attached. These tests assert every such action rejects a
 * traversal payload BEFORE any fetch is attempted, and still accepts a valid id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the client so a valid id resolves without real network, and so we can
// assert no request is ever built for a malicious id.
const vtexFetchWithCookies = vi.fn();
vi.mock("../client", () => ({
  vtexFetchWithCookies: (...args: unknown[]) => vtexFetchWithCookies(...args),
  getVtexConfig: () => ({ salesChannel: "1", country: "BRA" }),
}));

import * as checkout from "../actions/checkout";

const VALID_ID = "31608bfb4aba45a8beafe03d60f7447a"; // 32 hex
const TRAVERSAL = "../../../dataentities/CL/search?_fields=email&_size=0#";

beforeEach(() => {
  vtexFetchWithCookies.mockReset();
  vtexFetchWithCookies.mockResolvedValue({ items: [] });
});

describe("checkout orderFormId validation", () => {
  const byOrderFormId: Array<[string, (id: string) => Promise<unknown>]> = [
    ["getOrCreateCart", (id) => checkout.getOrCreateCart({ orderFormId: id })],
    ["getOrCreateCartV2", (id) => checkout.getOrCreateCartV2({ orderFormId: id })],
    ["addItemsToCart", (id) => checkout.addItemsToCart({ orderFormId: id, orderItems: [] })],
    ["updateCartItems", (id) => checkout.updateCartItems({ orderFormId: id, orderItems: [] })],
    ["removeAllItems", (id) => checkout.removeAllItems({ orderFormId: id })],
    ["addCouponToCart", (id) => checkout.addCouponToCart({ orderFormId: id, text: "x" })],
    ["removeAllItems", (id) => checkout.removeAllItems({ orderFormId: id })],
    ["getInstallments", (id) => checkout.getInstallments({ orderFormId: id, paymentSystem: 1 })],
    ["clearOrderFormMessages", (id) => checkout.clearOrderFormMessages({ orderFormId: id })],
    ["changeToAnonymousUser", (id) => checkout.changeToAnonymousUser({ orderFormId: id })],
    [
      "updateOrderFormProfile",
      (id) => checkout.updateOrderFormProfile({ orderFormId: id, fields: {} }),
    ],
    [
      "updateOrderFormAttachment",
      (id) =>
        checkout.updateOrderFormAttachment({ orderFormId: id, attachment: "clientData", body: {} }),
    ],
  ];

  for (const [name, call] of byOrderFormId) {
    it(`${name} rejects a traversal orderFormId and never fetches`, async () => {
      await expect(call(TRAVERSAL)).rejects.toThrow(/invalid orderFormId/);
      expect(vtexFetchWithCookies).not.toHaveBeenCalled();
    });

    it(`${name} accepts a valid 32-hex orderFormId`, async () => {
      await call(VALID_ID).catch(() => {});
      expect(vtexFetchWithCookies).toHaveBeenCalled();
      const path = String(vtexFetchWithCookies.mock.calls[0][0]);
      expect(path).toContain(VALID_ID);
      expect(path).not.toContain("..");
      expect(path.startsWith("/api/checkout/")).toBe(true);
    });
  }

  it("rejects near-miss ids (wrong length, non-hex, encoded dot)", async () => {
    for (const bad of ["abc", "g".repeat(32), "..", "%2e%2e", `${VALID_ID}/x`, `${VALID_ID}#`]) {
      await expect(checkout.addItemsToCart({ orderFormId: bad, orderItems: [] })).rejects.toThrow();
    }
    expect(vtexFetchWithCookies).not.toHaveBeenCalled();
  });
});

describe("checkout non-id path segments", () => {
  it("rejects a traversal attachment name", async () => {
    await expect(
      checkout.updateOrderFormAttachment({
        orderFormId: VALID_ID,
        attachment: "../../../dataentities/CL/search#",
        body: {},
      }),
    ).rejects.toThrow(/invalid attachment/);
    expect(vtexFetchWithCookies).not.toHaveBeenCalled();
  });

  it("rejects a non-integer itemIndex", async () => {
    await expect(
      checkout.updateItemPrice({
        orderFormId: VALID_ID,
        itemIndex: "0/../../x" as unknown as number,
        price: 1,
      }),
    ).rejects.toThrow(/invalid itemIndex/);
    expect(vtexFetchWithCookies).not.toHaveBeenCalled();
  });

  it("rejects a traversal offeringId", async () => {
    await expect(
      checkout.removeOffering({
        orderFormId: VALID_ID,
        itemIndex: 0,
        offeringId: "../../x",
      }),
    ).rejects.toThrow(/invalid offeringId/);
    expect(vtexFetchWithCookies).not.toHaveBeenCalled();
  });
});
