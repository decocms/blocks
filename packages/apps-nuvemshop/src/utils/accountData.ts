/**
 * Customer data operations. Every function takes the SESSION customer id
 * (`sessionCustomerId()`), never client input. Per-user data: never cached
 * (`nuvemshopAdmin` goes through the raw transport, not the shared GET cache).
 */
import { nuvemshopAdmin } from "../admin";
import { sessionCustomerId, storeFetch } from "../store";
import { AccountError, isValidCpf, mapAdminError, normalizePhone, parseId } from "./account";
import { type Address, mapOrder, mapOrderDetail, type Order, type OrderDetail } from "./orders";

const BILLING = [
  "name",
  "phone",
  "address",
  "number",
  "floor",
  "locality",
  "zipcode",
  "city",
  "province",
  "country",
] as const;
type BillingKey = `billing_${(typeof BILLING)[number]}`;

export interface Profile extends Partial<Record<BillingKey, string | null>> {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  identification: string | null;
}
export type ProfileInput = Partial<Pick<Profile, "name" | "phone" | "identification" | BillingKey>>;

type Raw = any;

async function admin(path: string, init?: { method?: string; body?: unknown }): Promise<Raw> {
  const res = await nuvemshopAdmin(path, init);
  if (res.ok) return res.json();
  throw mapAdminError(res.status, await res.json().catch(() => null));
}

const pickProfile = (c: Raw): Profile => ({
  id: c.id,
  name: c.name,
  email: c.email,
  phone: c.phone ?? null,
  identification: c.identification ?? null,
  ...Object.fromEntries(BILLING.map((k) => [`billing_${k}`, c[`billing_${k}`] ?? null])),
});

export const getProfile = async (customerId: number): Promise<Profile> =>
  pickProfile(await admin(`/customers/${customerId}`));

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function updateProfile(customerId: number, input: ProfileInput): Promise<Profile> {
  if (!input || typeof input !== "object") throw new AccountError("Confira os dados informados.");
  const body: Record<string, string | null> = {};
  // Allow-list: only these keys ever reach the Admin API (no email/note/password/extra).
  if (input.name !== undefined) {
    if (!clean(input.name)) throw new AccountError("Informe seu nome.");
    body.name = clean(input.name);
  }
  if (input.identification !== undefined) {
    const v = clean(input.identification);
    if (v && !isValidCpf(v)) throw new AccountError("CPF inválido.");
    body.identification = v ? v.replace(/\D/g, "") : null;
  }
  for (const k of ["phone", "billing_phone"] as const) {
    if (input[k] === undefined) continue;
    const v = clean(input[k]);
    const p = v && normalizePhone(v);
    if (v && !p) throw new AccountError("Telefone inválido. Use DDD + número.");
    body[k] = p || null;
  }
  for (const k of BILLING) {
    const key = `billing_${k}` as BillingKey;
    if (key === "billing_phone" || input[key] === undefined) continue;
    // billing_country can't be null, "" clears it.
    body[key] = clean(input[key]) || (k === "country" ? "" : null);
  }
  if (!Object.keys(body).length) return getProfile(customerId);
  return pickProfile(await admin(`/customers/${customerId}`, { method: "PUT", body }));
}

/* -------------------------------- addresses -------------------------------- */

export interface AddressInput {
  name?: string;
  address: string;
  number: string;
  floor?: string;
  locality: string;
  city: string;
  province: string;
  zipcode: string;
  phone?: string;
}

function validateAddress(a: AddressInput) {
  if (!a || typeof a !== "object")
    throw new AccountError("Preencha todos os campos obrigatórios do endereço.");
  const out = {
    name: clean(a.name),
    address: clean(a.address),
    number: clean(a.number),
    floor: clean(a.floor),
    locality: clean(a.locality),
    city: clean(a.city),
    province: clean(a.province),
    zipcode: clean(a.zipcode).replace(/\D/g, ""),
    phone: clean(a.phone),
  };
  for (const k of ["address", "number", "locality", "city", "province"] as const)
    if (!out[k]) throw new AccountError("Preencha todos os campos obrigatórios do endereço.");
  if (out.zipcode.length !== 8) throw new AccountError("CEP inválido.");
  if (out.phone) {
    const p = normalizePhone(out.phone);
    if (!p) throw new AccountError("Telefone inválido. Use DDD + número.");
    out.phone = p;
  }
  return out;
}

export async function listAddresses(customerId: number): Promise<Address[]> {
  const c = await admin(`/customers/${customerId}?fields=addresses,default_address`);
  const list: Address[] = c.addresses ?? [];
  const def = c.default_address?.id ?? list.find((a) => a.default)?.id;
  return list.map((a) => ({ ...a, default: a.id === def }));
}

/** Admin PUT with `addresses` appends (existing ones are kept); response lists only the new one. */
export async function addAddress(customerId: number, input: AddressInput): Promise<Address> {
  const { name: _name, ...a } = validateAddress(input); // Admin ignores `name`
  const c = await admin(`/customers/${customerId}`, {
    method: "PUT",
    body: { addresses: [{ ...a, country: "BR" }] },
  });
  return c.addresses?.[0];
}

/** Brasil in the store's country <select>. */
const COUNTRY_BR = "30";

/** Updates in place through the storefront form (Admin PUT would create a duplicate). */
export async function updateAddress(
  customerId: number,
  addressId: unknown,
  input: AddressInput,
): Promise<void> {
  const a = validateAddress(input);
  // Ownership: only ids from the session customer's own address list.
  const id = parseId(addressId);
  const current = id && (await listAddresses(customerId)).find((x) => String(x.id) === String(id));
  if (!id || !current) throw new AccountError("Endereço não encontrado.", 404);
  // Trailing slash matters: without it the POST is dropped by a 302.
  const res = await storeFetch(`/account/address/${id}/`, {
    method: "POST",
    form: {
      ...a,
      // The form rejects an empty label (silently): keep the current one.
      name: a.name || current.name || "Endereço",
      // ...and "+55": it wants national digits (ex.: 11912345678).
      phone: a.phone.replace(/^\+55/, ""),
      country: COUNTRY_BR,
    },
  });
  // Saved -> 302 to the address list; rejected -> 302 back to the form.
  if (!res.location?.includes("/account/addresses"))
    throw new AccountError("Não foi possível salvar o endereço. Confira os dados.");
}

/* --------------------------------- orders --------------------------------- */

const owns = (o: Raw, customerId: number) =>
  o?.customer?.id != null && String(o.customer.id) === String(customerId);

export async function listOrders(
  customerId: number,
  { page = 1, perPage = 10 }: { page?: number; perPage?: number } = {},
): Promise<Order[]> {
  const pg = Math.min(Math.max(Math.trunc(Number(page)) || 1, 1), 1000);
  const per = Math.min(Math.max(Math.trunc(Number(perPage)) || 10, 1), 50);
  const q = new URLSearchParams({
    customer_ids: String(customerId),
    per_page: String(per),
    page: String(pg),
  });
  const res = await nuvemshopAdmin(`/orders?${q}`);
  if (res.status === 404) {
    // Empty results are 404 "Last page is 0", not [].
    const b = await res.json().catch(() => null);
    if (/last page/i.test(b?.description ?? "")) return [];
    throw mapAdminError(404, b);
  }
  if (!res.ok) throw mapAdminError(res.status, await res.json().catch(() => null));
  // Defense in depth: never trust the upstream filter, drop anything not owned by the session customer.
  return ((await res.json()) as Raw[]).filter((o) => owns(o, customerId)).map(mapOrder);
}

const orderNotFound = () => new AccountError("Pedido não encontrado.", 404);

export async function getOrder(customerId: number, orderId: unknown): Promise<OrderDetail> {
  const id = parseId(orderId);
  if (!id) throw orderNotFound();
  const res = await nuvemshopAdmin(`/orders/${id}?aggregates=fulfillment_orders`);
  // Missing and not-yours are indistinguishable (same message and status).
  if (res.status === 404) throw orderNotFound();
  if (!res.ok) throw mapAdminError(res.status, await res.json().catch(() => null));
  const o = await res.json();
  if (!owns(o, customerId)) throw orderNotFound();
  return mapOrderDetail(o);
}

/** Resolves the session customer id or throws 401 (never a default id). */
export async function requireCustomerId(): Promise<number> {
  const id = await sessionCustomerId();
  if (!id) throw new AccountError("Faça login para continuar.", 401);
  return id;
}
