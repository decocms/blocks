/**
 * The shape of a `secret` block's `ciphertext` (spec: built-in-blocks ›
 * Secrets). `deco check` and the content protocol's secret guard check it
 * without a key: they can tell a well-formed value from plain text or a
 * truncated paste, but can't decrypt it.
 *
 * Format, version 1: `v1.<wrappedKey>.<iv>.<sealed>`, each part base64url
 * without padding:
 *
 * - `wrappedKey`: the per-value AES-256-GCM key, wrapped with the site's RSA
 *   public key by RSA-OAEP/SHA-256, so it is exactly the modulus size
 *   (256, 384 or 512 bytes for 2048-, 3072- and 4096-bit keys);
 * - `iv`: the 12-byte GCM nonce;
 * - `sealed`: the AES-GCM output, ciphertext plus the 16-byte tag.
 *
 * TODO(N-03): `@decocms/blocks/secrets` (`encryptSecret`, the `secret` block's
 * decryption) owns this format. When it lands, import its parser here so the
 * check and the encrypter can never disagree.
 */

const B64URL = /^[A-Za-z0-9_-]+$/;
const RSA_MODULUS_BYTES = new Set([256, 384, 512]);

function decodedLength(part: string): number {
  // base64url without padding: 4 chars → 3 bytes, remainder 2 → 1, 3 → 2.
  const rem = part.length % 4;
  if (rem === 1) return -1;
  return Math.floor(part.length / 4) * 3 + (rem === 0 ? 0 : rem - 1);
}

/** Why `ciphertext` isn't a well-formed v1 secret, or null when it is. */
export function ciphertextProblem(ciphertext: unknown): string | null {
  if (typeof ciphertext !== "string") return "ciphertext must be a string";
  const parts = ciphertext.split(".");
  if (parts[0] !== "v1") return 'ciphertext must start with "v1."';
  if (parts.length !== 4) return "ciphertext must have four dot-separated parts";
  const [, wrappedKey, iv, sealed] = parts;
  if (![wrappedKey, iv, sealed].every((p) => p.length > 0 && B64URL.test(p))) {
    return "ciphertext parts must be base64url";
  }
  if (!RSA_MODULUS_BYTES.has(decodedLength(wrappedKey))) {
    return "ciphertext's wrapped key isn't an RSA-OAEP block";
  }
  if (decodedLength(iv) !== 12) return "ciphertext's IV must be 12 bytes";
  if (decodedLength(sealed) < 16) return "ciphertext is too short to hold a GCM tag";
  return null;
}
