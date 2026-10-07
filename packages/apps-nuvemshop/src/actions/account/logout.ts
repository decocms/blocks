import { storeFetch } from "../../store";

/**
 * @title Nuvemshop - Logout
 * @description Ends the store session (and forwards the expired session cookie).
 */
export default async function logout(_props: unknown): Promise<{ ok: true }> {
  await storeFetch("/account/logout/");
  return { ok: true };
}
