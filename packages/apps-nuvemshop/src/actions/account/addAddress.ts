import { type AddressInput, addAddress, requireCustomerId } from "../../utils/accountData";
import type { Address } from "../../utils/orders";

export type Props = AddressInput;

/**
 * @title Nuvemshop - Add address
 * @description Adds an address (Brazil) to the logged-in buyer.
 */
export default async function addAddressAction(props: Props): Promise<Address> {
  return addAddress(await requireCustomerId(), props);
}
