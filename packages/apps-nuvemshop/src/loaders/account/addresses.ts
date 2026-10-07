import { listAddresses, requireCustomerId } from "../../utils/accountData";
import type { Address } from "../../utils/orders";

/**
 * @title Nuvemshop - Customer addresses
 * @description The logged-in buyer's saved addresses (id taken from the store session).
 */
export default async function addresses(_props: unknown): Promise<Address[]> {
  return listAddresses(await requireCustomerId());
}

export const cache = "no-store";
