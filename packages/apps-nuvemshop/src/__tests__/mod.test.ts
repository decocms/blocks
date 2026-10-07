import { describe, expect, it } from "vitest";
import { getNuvemshopConfig } from "../client";
import NuvemshopApp, { configure, type Props } from "../mod";
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

  it("resolves the admin token and Turnstile secret as secrets and keeps storeUrl", async () => {
    const keys: string[] = [];
    await configure(
      {
        storeId: "1",
        storeUrl: "https://loja.example/",
        adminToken: { e: 1 },
        turnstileSecret: { e: 2 },
        allowUnverifiedRegistration: true,
      },
      async (_v, key) => {
        keys.push(key);
        return `secret-for-${key}`;
      },
    );
    expect(keys).toEqual([
      "NUVEMSHOP_STOREFRONT_TOKEN",
      "NUVEMSHOP_ADMIN_TOKEN",
      "NUVEMSHOP_TURNSTILE_SECRET",
    ]);
    expect(getNuvemshopConfig()).toMatchObject({
      storeUrl: "https://loja.example/",
      adminToken: "secret-for-NUVEMSHOP_ADMIN_TOKEN",
      turnstileSecret: "secret-for-NUVEMSHOP_TURNSTILE_SECRET",
      allowUnverifiedRegistration: true,
    });
  });

  it("resolves the token through the secret resolver (env fallback key)", async () => {
    const keys: string[] = [];
    await configure({ storeId: "1", token: { encrypted: "x" } }, async (_v, key) => {
      keys.push(key);
      return key === "NUVEMSHOP_STOREFRONT_TOKEN" ? "tok" : null;
    });
    expect(keys[0]).toBe("NUVEMSHOP_STOREFRONT_TOKEN");
    expect(getNuvemshopConfig().token).toBe("tok");
  });
});

describe("CMS Props (admin form for the deco-nuvemshop block)", () => {
  it("is the shape configure() reads, and is the default export's input", async () => {
    const props: Props = {
      storeId: "8336778",
      currency: "ARS",
      defaultSort: "price-ascending",
      apiVersion: "v2026-11",
    };
    expect(NuvemshopApp(props)).toEqual({ state: props });
    await configure({ ...props }, noSecret);
    expect(getNuvemshopConfig()).toMatchObject({
      storeId: "8336778",
      currency: "ARS",
      defaultSort: "price-ascending",
      apiVersion: "v2026-11",
    });
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
    ["https://demodeco.lojavirtualnuvem.com.br/account/login/", "store.account.login"],
    ["https://demodeco.lojavirtualnuvem.com.br/account/logout/", "store.account.logout"],
    ["https://demodeco.lojavirtualnuvem.com.br/account/", "store.account.page"],
    ["https://api.nuvemshop.com.br/v1/1/customers", "admin.customers"],
    ["https://api.nuvemshop.com.br/v1/1/customers/42", "admin.customers"],
    ["https://challenges.cloudflare.com/turnstile/v0/siteverify", "turnstile.verify"],
    ["https://example.com/other", undefined],
  ])("%s → %s", (url, op) => {
    expect(nuvemshopOperationRouter(url, "GET")).toBe(op);
  });
});
