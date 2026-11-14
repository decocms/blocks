import { getProfile, type Profile, requireCustomerId } from "../../utils/accountData";

/**
 * @title Nuvemshop - Customer profile
 * @description The logged-in buyer's profile (id taken from the store session; 401 when logged out).
 */
export default async function profile(_props: unknown): Promise<Profile> {
  return getProfile(await requireCustomerId());
}

export const cache = "no-store";
