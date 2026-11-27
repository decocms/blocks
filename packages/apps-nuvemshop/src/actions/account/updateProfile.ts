import {
  type Profile,
  type ProfileInput,
  requireCustomerId,
  updateProfile,
} from "../../utils/accountData";

export type Props = ProfileInput;

/**
 * @title Nuvemshop - Update profile
 * @description Updates the logged-in buyer's profile. Only allow-listed fields (name, phone, CPF, billing_*) are sent; email/password are not editable.
 */
export default async function updateProfileAction(props: Props): Promise<Profile> {
  return updateProfile(await requireCustomerId(), props);
}
