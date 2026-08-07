/**
 * Regression test for the CF Workers secret-decryption bug: in production/preview
 * DECO_CRYPTO_KEY is neither in process.env nor in .dev.vars — it only reaches
 * getEnvVar() via the `env` binding stashed in RequestContext (setRuntimeEnv).
 * If getEnvVar() stops consulting getRuntimeEnv(), encrypted secrets silently
 * decrypt to null in production and this test fails.
 */

import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveSecret } from "./crypto";
import { setRuntimeEnv } from "./otelAdapters";
import { RequestContext } from "./requestContext";

// Ensure crypto.subtle exists in the Node test runtime.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
  }
});

/** Build a DECO_CRYPTO_KEY value + an encrypted-hex ciphertext for `plaintext`. */
async function makeKeyAndCiphertext(plaintext: string) {
  const rawKey = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey("raw", rawKey, "AES-CBC", false, [
    "encrypt",
  ]);
  const ct = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: "AES-CBC", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const encryptedHex = Array.from(ct)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const decoCryptoKey = btoa(
    JSON.stringify({ key: Array.from(rawKey), iv: Array.from(iv) }),
  );
  return { decoCryptoKey, encryptedHex };
}

describe("resolveSecret in CF Workers (no process.env / no .dev.vars)", () => {
  it("decrypts using DECO_CRYPTO_KEY from the RequestContext env binding", async () => {
    // Use a unique plaintext so the module-level secretCache can't mask a
    // regression with a value cached by another test/run.
    const plaintext = `appToken-${Math.random().toString(36).slice(2)}`;
    const { decoCryptoKey, encryptedHex } = await makeKeyAndCiphertext(plaintext);

    // Guard: process.env must NOT carry the key, so the only source is the ALS.
    expect(process.env.DECO_CRYPTO_KEY).toBeUndefined();

    const resolved = await RequestContext.run(
      new Request("https://site.example/"),
      async () => {
        setRuntimeEnv({ DECO_CRYPTO_KEY: decoCryptoKey });
        return resolveSecret({ encrypted: encryptedHex });
      },
    );

    expect(resolved).toBe(plaintext);
  });
});
