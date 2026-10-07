import { nuvemshopAdmin } from "../admin";
import { getNuvemshopConfig } from "../client";
import { storeCookies, storeFetch } from "../store";

export interface NuvemshopUser {
  id: number;
  name?: string;
  email?: string;
  phone?: string | null;
}

/**
 * @title Nuvemshop - Logged-in customer
 * @description The buyer's account from the store session (null when logged out).
 * Reads the customer id from the store's account page and the profile from the Admin API.
 */
export default async function user(_props: unknown): Promise<NuvemshopUser | null> {
  if (!storeCookies()) return null;
  const page = await storeFetch("/account/");
  if (page.status !== 200) return null;
  const id = Number((await page.text()).match(/LS\.customer\s*=\s*(\d+)/)?.[1]);
  if (!id) return null;
  if (!getNuvemshopConfig().adminToken) return { id };
  const res = await nuvemshopAdmin(`/customers/${id}`);
  if (!res.ok) return { id };
  const c = (await res.json()) as NuvemshopUser;
  return { id: c.id, name: c.name, email: c.email, phone: c.phone };
}

export const cache = "no-store";
