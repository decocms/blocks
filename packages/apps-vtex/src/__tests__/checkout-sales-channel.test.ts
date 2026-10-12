/**
 * Every mutation of an orderForm must carry `?sc=<salesChannel>`.
 *
 * VTEX recalculates prices, availability and promotions against the sales
 * channel on the request. Omit it and the API falls back to the account
 * default, so a multi-channel store silently gets the wrong numbers written
 * onto the cart — and the storefront has no way to tell, because the call
 * still returns 200 with a well-formed orderForm.
 *
 * `deco-cx/apps` (`vtex/actions/cart/*.ts`) passes `sc: segment.payload.channel`
 * on all of these. The port to this package kept `sc` on some endpoints and
 * dropped it on others; this test pins the ones that were restored so the
 * difference cannot drift back in unnoticed.
 *
 * Endpoints deliberately NOT covered here — `deco-cx/apps` omits `sc` on them
 * too, so adding it would be a behaviour change rather than a port fix:
 * `addOffering`, `removeOffering`, `updateSelectableGifts`,
 * `clearOrderFormMessages`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  removeItemAttachment,
  setShippingPostalCode,
  updateItemAttachment,
  updateItemPrice,
  updateOrderFormAttachment,
  updateOrderFormProfile,
} from "../actions/checkout";
import { configureVtex, setVtexFetch } from "../client";

const ORDER_FORM_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function mockResponse(body: unknown = { orderFormId: ORDER_FORM_ID, items: [] }): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe("checkout actions — sales channel on orderForm mutations", () => {
  let lastUrl: string | undefined;

  beforeEach(() => {
    lastUrl = undefined;
    setVtexFetch(((url: string) => {
      lastUrl = url;
      return Promise.resolve(mockResponse());
    }) as unknown as typeof fetch);
  });

  afterEach(() => {
    // `setVtexFetch` writes module-level state, so put the real fetch back
    // rather than leaving the stub installed for whatever runs next. (Vitest
    // isolates per file, so this is belt-and-braces — but the stub captures
    // `lastUrl` from this closure, and a leak would be silent.)
    setVtexFetch(globalThis.fetch);
  });

  // `configureVtex` is module-level state too, but each inner `describe` sets
  // it in its own `beforeEach`, so no case here reads another's channel.

  describe("with a configured salesChannel", () => {
    beforeEach(() => {
      configureVtex({ account: "testaccount", salesChannel: "3" });
    });

    it("updateOrderFormAttachment", async () => {
      await updateOrderFormAttachment({
        orderFormId: ORDER_FORM_ID,
        attachment: "marketingData",
        body: { utmSource: "newsletter" },
      });
      expect(lastUrl).toContain(`/orderForm/${ORDER_FORM_ID}/attachments/marketingData?sc=3`);
    });

    it("updateItemAttachment", async () => {
      await updateItemAttachment({
        orderFormId: ORDER_FORM_ID,
        itemIndex: 0,
        attachment: "customData",
        content: {},
      });
      expect(lastUrl).toContain("/items/0/attachments/customData?sc=3");
    });

    it("removeItemAttachment", async () => {
      await removeItemAttachment({
        orderFormId: ORDER_FORM_ID,
        itemIndex: 0,
        attachment: "customData",
        content: {},
      });
      expect(lastUrl).toContain("/items/0/attachments/customData?sc=3");
    });

    it("updateItemPrice", async () => {
      await updateItemPrice({ orderFormId: ORDER_FORM_ID, itemIndex: 2, price: 1990 });
      expect(lastUrl).toContain("/items/2/price?sc=3");
    });

    it("updateOrderFormProfile", async () => {
      await updateOrderFormProfile({ orderFormId: ORDER_FORM_ID, fields: { email: "a@b.c" } });
      expect(lastUrl).toContain(`/orderForm/${ORDER_FORM_ID}/profile?sc=3`);
    });

    it("setShippingPostalCode", async () => {
      await setShippingPostalCode({ orderFormId: ORDER_FORM_ID, postalCode: "01310100" });
      expect(lastUrl).toContain("/attachments/shippingData?sc=3");
    });
  });

  describe("without a configured salesChannel", () => {
    beforeEach(() => {
      configureVtex({ account: "testaccount" });
    });

    it("leaves the URL clean instead of emitting an empty sc", async () => {
      await updateOrderFormAttachment({
        orderFormId: ORDER_FORM_ID,
        attachment: "marketingData",
        body: {},
      });
      expect(lastUrl).toContain(`/orderForm/${ORDER_FORM_ID}/attachments/marketingData`);
      expect(lastUrl).not.toContain("sc=");
      expect(lastUrl).not.toContain("?");
    });
  });
});
