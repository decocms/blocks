// Regression tests for "no user sees or changes another user's data". No network: fetch is mocked.
import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { describe, expect, it } from "vitest";
import addAddress from "../actions/account/addAddress";
import updateAddress from "../actions/account/updateAddress";
import updateProfile from "../actions/account/updateProfile";
import { configureNuvemshop, setNuvemshopFetch } from "../client";
import addresses from "../loaders/account/addresses";
import order from "../loaders/account/order";
import orders from "../loaders/account/orders";
import profile from "../loaders/account/profile";
import { sessionCustomerId } from "../store";
import { parseId } from "../utils/account";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const calls: { url: string; init?: RequestInit }[] = [];
const isAccountPage = (u: string) => u === "https://s.example/account/";

/** Mocks upstream; the store's /account/ page reports `session` as the logged-in customer. */
function mock(
  handler: (url: string, init?: RequestInit) => Response,
  session = "LS.customer = 7;",
) {
  calls.length = 0;
  configureNuvemshop({ storeId: "1", adminToken: "t", storeUrl: "https://s.example" });
  setNuvemshopFetch((async (u: unknown, i?: RequestInit) => {
    calls.push({ url: String(u), init: i });
    return isAccountPage(String(u)) ? new Response(session) : handler(String(u), i);
  }) as typeof fetch);
}
const as = <T>(fn: () => Promise<T>, cookie: string | null = "store_x=1") =>
  RequestContext.run(new Request("https://x.example/", cookie ? { headers: { cookie } } : {}), fn);
const msg = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: { status: number; message: string }) => `${e.status} ${e.message}`,
  );
const upstream = () => calls.filter((c) => !isAccountPage(c.url));
const ADDR = {
  address: "R",
  number: "1",
  locality: "B",
  city: "C",
  province: "SP",
  zipcode: "01001000",
};

describe("ownership", () => {
  it("foreign order == nonexistent order (same status and message)", async () => {
    mock((u) => (u.includes("/orders/1") ? json({ id: 1, customer: { id: 8 } }) : json({}, 404)));
    const foreign = await as(() => msg(order({ orderId: 1 })));
    expect(foreign).toBe("404 Pedido não encontrado.");
    expect(await as(() => msg(order({ orderId: 2 })))).toBe(foreign);
    expect(await as(() => msg(order({ orderId: 0 })))).toBe(foreign);
  });

  it("compares ids as strings (upstream string id still matches only the owner)", async () => {
    mock(() => json({ id: 1, customer: { id: "7" } }));
    expect(await as(() => msg(order({ orderId: 1 })))).toBe("OK");
    mock(() => json({ id: 1, customer: { id: "7" } }), "LS.customer = 70;");
    expect(await as(() => msg(order({ orderId: 1 })))).toBe("404 Pedido não encontrado.");
  });

  it("path/query injection ids never reach the Admin API", async () => {
    mock(() => json({ id: 1, customer: { id: 7 } }));
    for (const bad of [
      "1,2",
      "../customers/8",
      "123?customer_ids=8",
      "1e3",
      " 1",
      "-1",
      1.5,
      Number.NaN,
      null,
      {},
      1e21,
    ]) {
      expect(parseId(bad)).toBeNull();
      expect(await as(() => msg(order({ orderId: bad as number })))).toBe(
        "404 Pedido não encontrado.",
      );
    }
    expect(upstream()).toHaveLength(0);
    expect(parseId("42")).toBe(42);
  });

  it("orders sends the session id, clamps paging and drops foreign orders", async () => {
    mock(() => json([{ id: 1, customer: { id: 7 } }, { id: 2, customer: { id: 8 } }, { id: 3 }]));
    const r = await as(() => orders({ page: 99999, perPage: 9999 }));
    expect(r.map((o) => o.id)).toEqual([1]);
    const q = new URL(upstream()[0].url).searchParams;
    expect([q.get("customer_ids"), q.get("per_page"), q.get("page")]).toEqual(["7", "50", "1000"]);
  });

  it("orders: empty page (404 Last page) is []", async () => {
    mock(() => json({ description: "Last page is 0" }, 404));
    expect(await as(() => orders({}))).toEqual([]);
  });

  it("profile/updateProfile target the session customer and allow-list fields", async () => {
    mock(() => json({ id: 7, name: "A", email: "e" }));
    await as(() => profile({}));
    expect(upstream()[0].url).toContain("/customers/7");
    await as(() => updateProfile({ name: "A", id: 8, customer_id: 8, email: "x@y.z" } as never));
    const put = upstream()[1];
    expect(put.url).toContain("/customers/7");
    expect(JSON.parse(String(put.init?.body))).toEqual({ name: "A" });
  });

  it("addAddress writes to the session customer only", async () => {
    mock(() => json({ addresses: [{ id: 10 }] }));
    await as(() => addAddress({ ...ADDR, customer_id: 8 } as never));
    expect(upstream()[0].url).toContain("/customers/7");
    expect(JSON.parse(String(upstream()[0].init?.body))).not.toHaveProperty("customer_id");
  });

  it("updateAddress with a foreign address id is rejected before any write", async () => {
    mock(() => json({ addresses: [{ id: 10 }] }));
    expect(await as(() => msg(updateAddress({ ...ADDR, addressId: 11 })))).toBe(
      "404 Endereço não encontrado.",
    );
    expect(await as(() => msg(updateAddress({ ...ADDR, addressId: "10/../11" })))).toBe(
      "404 Endereço não encontrado.",
    );
    expect(calls.every((c) => c.init?.method !== "POST")).toBe(true);
  });
});

describe("session", () => {
  it("logged out -> 401 on every entry point, nothing reaches the Admin API", async () => {
    mock(() => json({}), "LS.customer = false;");
    for (const run of [
      () => profile({}),
      () => orders({}),
      () => order({ orderId: 1 }),
      () => addAddress(ADDR),
      () => updateProfile({ name: "A" }),
      () => updateAddress({ ...ADDR, addressId: 10 }),
      () => addresses({}),
    ]) {
      expect(await as(() => msg(run()))).toBe("401 Faça login para continuar.");
      expect(await as(() => msg(run()), null)).toBe("401 Faça login para continuar.");
    }
    expect(upstream()).toHaveLength(0);
  });

  it("real logged-in /account/ snippet (verified on a live store) parses", async () => {
    mock(
      () => json({}),
      "<script>\nLS.customer = 350524152;\nLS.customerHasPriceTables = false;\n</script>",
    );
    expect(await as(() => sessionCustomerId())).toBe(350524152);
  });

  it("memoizes the session lookup per request", async () => {
    mock(() => json({ id: 7, name: "A", email: "e", addresses: [] }));
    await as(async () => {
      await profile({});
      await addresses({});
    });
    expect(calls.filter((c) => isAccountPage(c.url))).toHaveLength(1);
  });

  it("conflicting LS.customer values fail closed; single value works; non-store cookies are not forwarded", async () => {
    mock(() => json({}), "LS.customer = 7;\nOlá LS.customer = 8; ");
    expect(await as(() => sessionCustomerId())).toBeNull();
    mock(() => json({}), "LS.customer = 7;\nLS.customerHasPriceTables = false;");
    expect(await as(() => sessionCustomerId(), "a=1; store_x=1")).toBe(7);
    expect((calls[0].init!.headers as Record<string, string>).cookie).toBe("store_x=1");
  });

  it("redirected /account/ (expired session) -> null", async () => {
    calls.length = 0;
    configureNuvemshop({ storeId: "1", adminToken: "t", storeUrl: "https://s.example" });
    setNuvemshopFetch((async () => new Response("", { status: 302 })) as typeof fetch);
    expect(await as(() => sessionCustomerId())).toBeNull();
  });
});
