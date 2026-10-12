import { describe, expect, it } from "vitest";
import { CIPHERTEXT, generateSecretsKeyPair } from "./__tests__/fixtures";
import {
  decodeBase64Url,
  encodeBase64Url,
  encryptToCiphertext,
  formatCiphertext,
  parseCiphertext,
  publicKeyDerFromPem,
} from "./ciphertext";
import { isWellFormedCiphertext } from "./secrets";

describe("base64url", () => {
  it("round-trips bytes without padding", () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32, 384]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 250) & 0xff);
      const text = encodeBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(decodeBase64Url(text)).toEqual(bytes);
    }
  });

  it("refuses padding, standard-base64 characters and non-canonical encodings", () => {
    expect(decodeBase64Url("QQ==")).toBeNull();
    expect(decodeBase64Url("a+b/")).toBeNull();
    expect(decodeBase64Url("QR")).toBeNull(); // stray low bits: "QQ" is the canonical spelling
    expect(decodeBase64Url("Q")).toBeNull();
  });
});

describe("ciphertext format", () => {
  it("formats and parses v1.<wrappedKey>.<iv>.<ciphertext>", () => {
    const parts = parseCiphertext(CIPHERTEXT);
    expect(parts?.wrappedKey.byteLength).toBe(384);
    expect(parts?.iv.byteLength).toBe(12);
    expect(parts?.ciphertext.byteLength).toBe(32);
    expect(formatCiphertext(parts!)).toBe(CIPHERTEXT);
    expect(CIPHERTEXT.split(".")).toHaveLength(4);
  });

  it("refuses to format segments of the wrong length", () => {
    expect(() =>
      formatCiphertext({
        wrappedKey: new Uint8Array(100),
        iv: new Uint8Array(12),
        ciphertext: new Uint8Array(16),
      }),
    ).toThrow(RangeError);
  });
});

describe("encryptToCiphertext", () => {
  it("produces a well-formed ciphertext the private key decrypts", async () => {
    const { privateKey, publicKeyPem } = await generateSecretsKeyPair();
    const ciphertext = await encryptToCiphertext(publicKeyPem, "hunter2 — ünïcødé");
    expect(isWellFormedCiphertext(ciphertext)).toBe(true);
    expect(ciphertext).not.toContain("hunter2");

    const parts = parseCiphertext(ciphertext)!;
    expect(parts.wrappedKey.byteLength).toBe(256);
    const rawKey = await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      parts.wrappedKey as BufferSource,
    );
    const aes = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: parts.iv as BufferSource },
      aes,
      parts.ciphertext as BufferSource,
    );
    expect(new TextDecoder().decode(plain)).toBe("hunter2 — ünïcødé");
  });

  it("uses a fresh key and iv for every value", async () => {
    const { publicKeyPem } = await generateSecretsKeyPair();
    const [a, b] = await Promise.all([
      encryptToCiphertext(publicKeyPem, "same"),
      encryptToCiphertext(publicKeyPem, "same"),
    ]);
    expect(a).not.toBe(b);
  });

  it("refuses anything but a single PUBLIC KEY PEM", async () => {
    await expect(encryptToCiphertext("not a key", "x")).rejects.toThrow(TypeError);
  });
});

describe("publicKeyDerFromPem", () => {
  const pem = "-----BEGIN PUBLIC KEY-----\nQUJD\nREVG\n-----END PUBLIC KEY-----\n";

  it("reads one PUBLIC KEY block", () => {
    expect(Array.from(publicKeyDerFromPem(pem)!)).toEqual(
      Array.from(new TextEncoder().encode("ABCDEF")),
    );
  });

  it.each([
    ["a private key", pem.replace(/PUBLIC/g, "PRIVATE")],
    ["two blocks", pem + pem],
    [
      "a private key after the public one",
      `${pem}-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n`,
    ],
    ["text around the block", `secret=1\n${pem}`],
    ["a body that isn't base64", pem.replace("QUJD", "Q!JD")],
    ["no PEM at all", "ssh-rsa AAAA"],
  ])("refuses %s", (_label, text) => {
    expect(publicKeyDerFromPem(text)).toBeNull();
  });
});
