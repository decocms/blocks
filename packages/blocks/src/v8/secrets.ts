/**
 * `@decocms/blocks/secrets`: encrypts a value for a `secret` block, for a
 * script or an AI agent that writes content (see /next/api-reference#secrets).
 * Web Crypto only, so it runs in browsers, on Workers and on Node.
 */
import { encryptToCiphertext } from "./ciphertext.ts";

/**
 * Encrypts `value` with your public key (the contents of `.deco/secrets.pub`)
 * and returns a ready `secret` block.
 */
export async function encryptSecret(
  publicKey: string,
  value: string,
): Promise<{ __resolveType: "secret"; ciphertext: string }> {
  return { __resolveType: "secret", ciphertext: await encryptToCiphertext(publicKey, value) };
}
