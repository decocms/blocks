import { RequestContext } from "@decocms/blocks/sdk/requestContext";
import { beforeEach, describe, expect, it, vi } from "vitest";
import login from "../actions/account/login";
import logout from "../actions/account/logout";
import register from "../actions/account/register";
import { configureNuvemshop, setNuvemshopFetch } from "../client";
import user from "../loaders/user";

const STORE = "https://demodeco.lojavirtualnuvem.com.br";
const SITE = "https://www.loja.example";
const ADMIN = "https://api.nuvemshop.com.br/v1/8336778";

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Route> = {};
const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(String(input));
  const key = `${init.method ?? "GET"} ${url.origin}${url.pathname}`;
  const route = routes[key];
  if (!route) throw new Error(`unexpected ${key}`);
  return route(url, init);
});
const calls = (key: string) =>
  fetchMock.mock.calls.filter(
    ([u, i]) =>
      `${i?.method ?? "GET"} ${new URL(String(u)).origin}${new URL(String(u)).pathname}` === key,
  );
const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { "content-type": "text/html", ...init.headers } });
const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
};
const SESSION_SET = `store_session_payload_8336778=NEW; expires=Thu, 05-Nov-2026 23:56:42 GMT; path=/; domain=demodeco.lojavirtualnuvem.com.br; secure; HttpOnly; SameSite=Lax`;
const inRequest = <T>(fn: () => Promise<T>, cookie = "") =>
  RequestContext.run(new Request(`${SITE}/deco/invoke/x`, { headers: { cookie } }), async () => {
    const result = await fn();
    return { result, setCookies: RequestContext.current!.responseHeaders.getSetCookie() };
  });

beforeEach(() => {
  fetchMock.mockClear();
  routes = {};
  configureNuvemshop({ storeId: "8336778", storeUrl: STORE, adminToken: "admintoken" });
  setNuvemshopFetch(fetchMock as unknown as typeof fetch);
});

describe("login", () => {
  it("posts the classic form and forwards the store session cookie onto our domain", async () => {
    const CF =
      "__cf_bm=abc; HttpOnly; SameSite=None; Secure; Path=/; Domain=lojavirtualnuvem.com.br";
    routes[`POST ${STORE}/account/login/`] = () => redirect(`${STORE}/account/`, [SESSION_SET, CF]);
    const { result, setCookies } = await inRequest(
      () => login({ email: "a@b.com", password: "pw" }),
      "store_session_payload_8336778=OLD; _ga=GA1.1; other=x",
    );
    expect(result).toEqual({ ok: true });

    const [, init] = calls(`POST ${STORE}/account/login/`)[0];
    expect(String(init!.body)).toBe("email=a%40b.com&password=pw");
    const headers = new Headers(init!.headers);
    // only the store's own cookies go upstream — never the site's (_ga, other)
    expect(headers.get("cookie")).toBe("store_session_payload_8336778=OLD");
    expect(headers.get("origin")).toBe(STORE);
    expect(init!.redirect).toBe("manual");

    // only the store session is re-emitted on our domain (not the store's Cloudflare cookies)
    expect(setCookies).toEqual([
      SESSION_SET.replace("domain=demodeco.lojavirtualnuvem.com.br", "Domain=www.loja.example"),
    ]);
  });

  it.each([
    [
      '<div class="alert alert-danger js-login-general-error"> Esses dados estão incorretos.',
      "invalid_credentials",
    ],
    [
      '<div class="js-account-validation-pending alert alert-danger">Valide seu e-mail',
      "email_not_validated",
    ],
    ["<form id=login-form></form>", "unknown"],
  ])("maps the login page marker to a reason (%#)", async (marker, error) => {
    routes[`POST ${STORE}/account/login/`] = () =>
      redirect(`${STORE}/account/login/`, [SESSION_SET]);
    routes[`GET ${STORE}/account/login/`] = () => html(`<html>${marker}</html>`);
    const { result } = await inRequest(() => login({ email: "a@b.com", password: "bad" }));
    expect(result).toEqual({ ok: false, error });
    // the follow-up page read reuses the session the POST just set
    expect(new Headers(calls(`GET ${STORE}/account/login/`)[0][1]!.headers).get("cookie")).toBe(
      "store_session_payload_8336778=NEW",
    );
  });

  it("rejects missing credentials without calling the store", async () => {
    const { result } = await inRequest(() => login({ email: "", password: "" }));
    expect(result).toEqual({ ok: false, error: "invalid_credentials" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires storeUrl", async () => {
    configureNuvemshop({ storeId: "8336778" });
    await expect(inRequest(() => login({ email: "a@b.com", password: "pw" }))).rejects.toThrow(
      /storeUrl/,
    );
  });
});

describe("logout", () => {
  it("hits /account/logout/ with the session and forwards the expiring cookie", async () => {
    const expired =
      "store_session_payload_8336778=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; path=/; domain=demodeco.lojavirtualnuvem.com.br";
    routes[`GET ${STORE}/account/logout/`] = () => redirect(`${STORE}/`, [expired]);
    const { result, setCookies } = await inRequest(
      () => logout({}),
      "store_session_payload_8336778=S",
    );
    expect(result).toEqual({ ok: true });
    expect(setCookies[0]).toContain("Domain=www.loja.example");
  });
});

describe("register", () => {
  const ok = () =>
    new Response(JSON.stringify({ id: 350524152, email: "a@b.com", active: true }), {
      status: 201,
    });
  const props = { name: "Ana", email: "a@b.com", password: "s3nha-forte", captchaToken: "tok" };

  it("creates the customer through the Admin API (no reCAPTCHA) after verifying Turnstile", async () => {
    configureNuvemshop({
      storeId: "8336778",
      storeUrl: STORE,
      adminToken: "admintoken",
      turnstileSecret: "ts",
    });
    routes["POST https://challenges.cloudflare.com/turnstile/v0/siteverify"] = () =>
      Response.json({ success: true });
    routes[`POST ${ADMIN}/customers`] = ok;
    const { result } = await inRequest(() => register(props));
    expect(result).toEqual({ ok: true, customerId: 350524152, emailValidationRequired: true });

    const [, init] = calls(`POST ${ADMIN}/customers`)[0];
    expect(new Headers(init!.headers).get("authentication")).toBe("bearer admintoken");
    expect(new Headers(init!.headers).get("user-agent")).toMatch(/deco/);
    expect(JSON.parse(String(init!.body))).toEqual({
      name: "Ana",
      email: "a@b.com",
      password: "s3nha-forte",
      send_email_invite: false,
    });
    const verify = new URLSearchParams(
      String(calls("POST https://challenges.cloudflare.com/turnstile/v0/siteverify")[0][1]!.body),
    );
    expect(Object.fromEntries(verify)).toMatchObject({ secret: "ts", response: "tok" });
  });

  it("refuses when bot protection isn't configured (the Admin API has no captcha)", async () => {
    const { result } = await inRequest(() => register(props));
    expect(result).toEqual({ ok: false, error: "captcha_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows an explicit opt-out for demos", async () => {
    configureNuvemshop({
      storeId: "8336778",
      storeUrl: STORE,
      adminToken: "admintoken",
      allowUnverifiedRegistration: true,
    });
    routes[`POST ${ADMIN}/customers`] = ok;
    expect(
      (await inRequest(() => register({ ...props, captchaToken: undefined }))).result,
    ).toMatchObject({ ok: true });
  });

  it("maps a failed captcha, a taken email and weak input", async () => {
    configureNuvemshop({
      storeId: "8336778",
      storeUrl: STORE,
      adminToken: "admintoken",
      turnstileSecret: "ts",
    });
    routes["POST https://challenges.cloudflare.com/turnstile/v0/siteverify"] = () =>
      Response.json({ success: false });
    expect((await inRequest(() => register(props))).result).toEqual({
      ok: false,
      error: "captcha_failed",
    });

    routes["POST https://challenges.cloudflare.com/turnstile/v0/siteverify"] = () =>
      Response.json({ success: true });
    routes[`POST ${ADMIN}/customers`] = () =>
      Response.json({ email: ["The email must be unique."] }, { status: 422 });
    expect((await inRequest(() => register(props))).result).toEqual({
      ok: false,
      error: "email_taken",
    });

    expect((await inRequest(() => register({ ...props, email: "nope" }))).result).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect((await inRequest(() => register({ ...props, password: "123" }))).result).toEqual({
      ok: false,
      error: "invalid_input",
    });
  });

  it("requires the admin token", async () => {
    configureNuvemshop({ storeId: "8336778", storeUrl: STORE, allowUnverifiedRegistration: true });
    await expect(inRequest(() => register(props))).rejects.toThrow(/adminToken/);
  });
});

describe("user", () => {
  it("returns null without a store session and never calls upstream", async () => {
    const { result } = await inRequest(() => user({}), "_ga=1");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the store redirects to login", async () => {
    routes[`GET ${STORE}/account/`] = () => redirect(`${STORE}/account/login/`);
    expect((await inRequest(() => user({}), "store_session_payload_8336778=S")).result).toBeNull();
  });

  it("reads the logged-in customer id from the account page and its data from the Admin API", async () => {
    routes[`GET ${STORE}/account/`] = () => html("<script>LS.customer = 350524152;</script>");
    routes[`GET ${ADMIN}/customers/350524152`] = () =>
      Response.json({
        id: 350524152,
        name: "Ana",
        email: "a@b.com",
        phone: "11999990000",
        total_spent: "10.00",
        addresses: [],
      });
    const { result } = await inRequest(() => user({}), "store_session_payload_8336778=S");
    expect(result).toEqual({ id: 350524152, name: "Ana", email: "a@b.com", phone: "11999990000" });
  });

  it("falls back to just the id without an admin token", async () => {
    configureNuvemshop({ storeId: "8336778", storeUrl: STORE });
    routes[`GET ${STORE}/account/`] = () => html("<script>LS.customer = 7;</script>");
    expect((await inRequest(() => user({}), "store_session_payload_8336778=S")).result).toEqual({
      id: 7,
    });
  });
});
