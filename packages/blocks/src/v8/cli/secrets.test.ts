// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ciphertextProblem } from "./secrets";
import { sealSecret } from "./testing";

describe("ciphertext shape", () => {
  it.each([2048, 3072])("accepts a value sealed with a %i-bit key", async (bits) => {
    const { ciphertext } = await sealSecret("re_live_123", bits);
    expect(ciphertextProblem(ciphertext)).toBeNull();
  });

  it.each([
    [42, "ciphertext must be a string"],
    ["sk_live_plaintext", 'ciphertext must start with "v1."'],
    ["v1.AbX3", "ciphertext must have four dot-separated parts"],
    ["v1.a+b.c.d", "ciphertext parts must be base64url"],
    [
      "v1.AAAA.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA",
      "ciphertext's wrapped key isn't an RSA-OAEP block",
    ],
  ])("rejects %j", (value, message) => {
    expect(ciphertextProblem(value)).toBe(message);
  });

  it("checks the IV and tag sizes", async () => {
    const { ciphertext } = await sealSecret("x");
    const [v, key, , sealed] = ciphertext.split(".");
    expect(ciphertextProblem([v, key, "AAAA", sealed].join("."))).toBe(
      "ciphertext's IV must be 12 bytes",
    );
    const iv = ciphertext.split(".")[2];
    expect(ciphertextProblem([v, key, iv, "AAAA"].join("."))).toBe(
      "ciphertext is too short to hold a GCM tag",
    );
  });
});
