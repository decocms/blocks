import { describe, expect, it } from "vitest";
import { getNuvemshopConfig } from "../client";
import { configure } from "../mod";
import { nuvemshopOperationRouter } from "../utils/operationRouter";

const noSecret = async () => null;

describe("configure", () => {
  it("returns null without a numeric storeId", async () => {
    expect(await configure({}, noSecret)).toBeNull();
    expect(await configure({ storeId: "loja" }, noSecret)).toBeNull();
  });

  it("works tokenless and registers every manifest handler as a function", async () => {
    const app = await configure({ storeId: 8336778 }, noSecret);
    expect(app!.name).toBe("nuvemshop");
    expect(getNuvemshopConfig()).toMatchObject({ storeId: "8336778", token: undefined });
    for (const mod of [
      ...Object.values(app!.manifest.loaders),
      ...Object.values(app!.manifest.actions!),
    ]) {
      expect(typeof (mod as { default: unknown }).default).toBe("function");
    }
  });

  it("resolves the token through the secret resolver (env fallback key)", async () => {
    let envKey = "";
    await configure({ storeId: "1", token: { encrypted: "x" } }, async (_v, key) => {
      envKey = key;
      return "tok";
    });
    expect(envKey).toBe("NUVEMSHOP_STOREFRONT_TOKEN");
    expect(getNuvemshopConfig().token).toBe("tok");
  });
});

describe("nuvemshopOperationRouter", () => {
  const base = "https://storefront-api.tiendanube.com/v2026-11/stores/1";
  it.each([
    [`${base}/products?fields=id`, "products.browse"],
    [`${base}/products/camisa`, "products.get"],
    [`${base}/search/products?q=x`, "products.search"],
    [`${base}/categories`, "categories.list"],
    [`${base}/categories/calcados`, "categories.get"],
    [`${base}/shipping-options`, "shipping.options"],
    [`${base}/checkouts`, "checkout.create"],
    ["https://example.com/other", undefined],
  ])("%s → %s", (url, op) => {
    expect(nuvemshopOperationRouter(url, "GET")).toBe(op);
  });
});
