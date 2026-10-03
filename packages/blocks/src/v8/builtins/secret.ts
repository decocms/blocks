/**
 * The built-in `secret` block (see /next/built-in-blocks#secrets):
 * `{ "__resolveType": "secret", "ciphertext": "v1.…" }` resolves to the
 * decrypted string, on the server only.
 *
 * The ciphertext format is the protocol's (`../../protocol/ciphertext`, a leaf
 * module with no imports): a fresh AES-256-GCM key per value, wrapped with the
 * site's RSA public key using RSA-OAEP and SHA-256. Decrypting takes the
 * matching PKCS#8 private key, the PEM `createCMS({ secrets: { key } })` gets.
 *
 * Every failure (no key, the wrong key, a malformed ciphertext, a browser)
 * throws, so the resolver reports `BLOCK_FAILED` for that block alone. No
 * message ever includes the key or a decrypted value. `{ run: false }` and
 * `client.list` never run functions, so they return the ciphertext as saved.
 */
import { parseCiphertext } from "../../protocol/ciphertext";
import type { BlockFunction } from "../types";

/** True in a browser, where a secret must never be decrypted. */
function inBrowser(): boolean {
  const scope = globalThis as { window?: unknown; document?: unknown };
  return typeof scope.window === "object" && typeof scope.document === "object";
}

/** The DER bytes of a single `PRIVATE KEY` (PKCS#8) PEM block. */
function privateKeyDer(pem: string): Uint8Array {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/.exec(pem);
  return Uint8Array.from(atob(match?.[1]?.replace(/\s+/g, "") ?? ""), (c) => c.charCodeAt(0));
}

/**
 * The `secret` block for one private key. The CMS creates one per instance;
 * the built-in list holds the keyless one, which always fails.
 */
export function secretBlock(key?: string): BlockFunction {
  let imported: Promise<CryptoKey> | undefined;
  return async ({ ciphertext }: { ciphertext?: unknown } = {}): Promise<string> => {
    if (inBrowser()) throw new Error("a secret block resolves on the server only");
    if (!key) throw new Error("no key to decrypt secrets: pass createCMS({ secrets: { key } })");
    const parts = parseCiphertext(ciphertext);
    if (!parts) throw new Error("the ciphertext is not well formed");
    imported ??= Promise.resolve().then(() =>
      crypto.subtle.importKey(
        "pkcs8",
        privateKeyDer(key) as BufferSource,
        { name: "RSA-OAEP", hash: "SHA-256" },
        false,
        ["decrypt"],
      ),
    );
    let rsa: CryptoKey;
    try {
      rsa = await imported;
    } catch {
      throw new Error("the secrets key is not an RSA private key in PKCS#8 PEM");
    }
    try {
      const raw = await crypto.subtle.decrypt(
        { name: "RSA-OAEP" },
        rsa,
        parts.wrappedKey as BufferSource,
      );
      const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: parts.iv as BufferSource },
        aes,
        parts.ciphertext as BufferSource,
      );
      return new TextDecoder().decode(plain);
    } catch {
      // Web Crypto's errors say nothing useful, and this one never names the value.
      throw new Error("the secret could not be decrypted with this key");
    }
  };
}
