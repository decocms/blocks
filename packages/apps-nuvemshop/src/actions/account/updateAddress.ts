import { type AddressInput, requireCustomerId, updateAddress } from "../../utils/accountData";

export interface Props extends AddressInput {
  /** @title Address id */
  addressId: number | string;
}

/**
 * @title Nuvemshop - Update address
 * @description Updates one of the logged-in buyer's addresses through the store form. A foreign address id is 404.
 */
export default async function updateAddressAction(props: Props): Promise<{ ok: true }> {
  const { addressId, ...input } = props ?? ({} as Props);
  await updateAddress(await requireCustomerId(), addressId, input as AddressInput);
  return { ok: true };
}
