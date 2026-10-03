/**
 * Shared test fixtures: a small deco-meta@1 schema with a Secret field, and
 * helpers to call a handler in process.
 */
import { encodeBase64Url, formatCiphertext, publicKeyPemFromDer } from "../ciphertext";
import type { DecoMeta } from "../types";

export const SECRET_BLOCK = "newsletter";
export const SECRET_FIELD = "apiKey";

export const schemaFixture: DecoMeta = {
  manifest: {
    blocks: {
      sections: {
        hero: { $ref: "#/definitions/aGVybw==" },
        [SECRET_BLOCK]: { $ref: "#/definitions/bmV3c2xldHRlcg==" },
      },
      loaders: {
        multivariate: { $ref: "#/definitions/bXY=" },
        lazy: { $ref: "#/definitions/bGF6eQ==" },
      },
      content: { settings: { $ref: "#/definitions/c2V0dGluZ3M=" } },
    },
  },
  schema: {
    definitions: {
      "aGVybw==": {
        type: "object",
        properties: { title: { type: "string", title: "Heading" }, padding: { type: "string" } },
      },
      "bmV3c2xldHRlcg==": {
        type: "object",
        properties: {
          listId: { type: "string" },
          [SECRET_FIELD]: { type: "string", format: "secret", title: "API key" },
        },
      },
      "c2V0dGluZ3M=": {
        type: "object",
        properties: {
          integrations: {
            type: "array",
            items: {
              type: "object",
              properties: { token: { $ref: "#/definitions/U2VjcmV0" }, label: { type: "string" } },
            },
          },
          nested: {
            anyOf: [{ type: "object", properties: { key: { $ref: "#/definitions/U2VjcmV0" } } }],
          },
          extra: { type: "object", additionalProperties: { $ref: "#/definitions/U2VjcmV0" } },
        },
      },
      U2VjcmV0: { type: "string", format: "secret" },
      "bXY=": { type: "object", properties: { variants: { type: "array" } } },
      "bGF6eQ==": { type: "object", properties: { value: {} } },
    },
  },
};

const filled = (length: number, byte: number) => new Uint8Array(length).fill(byte);

/** A structurally valid ciphertext (3072-bit wrapped key, 12-byte iv, 32 bytes of ciphertext). */
export const CIPHERTEXT = formatCiphertext({
  wrappedKey: filled(384, 7),
  iv: filled(12, 1),
  ciphertext: filled(32, 2),
});

/** Builds `v1.<a>.<b>.<c>` from segment lengths, valid or not. */
export const ciphertextWithLengths = (wrappedKey: number, iv: number, ciphertext: number) =>
  ["v1", filled(wrappedKey, 3), filled(iv, 4), filled(ciphertext, 5)]
    .map((part) => (typeof part === "string" ? part : encodeBase64Url(part)))
    .join(".");

/** A fresh RSA-OAEP key pair, its public key as a `PUBLIC KEY` PEM (what `.deco/secrets.pub` holds). */
export async function generateSecretsKeyPair(modulusLength = 2048) {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: pair.privateKey, publicKeyPem: publicKeyPemFromDer(spki) };
}

export const secretBlock = (ciphertext = CIPHERTEXT) => ({ __resolveType: "secret", ciphertext });

/** A fetch that calls `handler` in process. */
export const inProcess = (handler: (request: Request) => Promise<Response>) => (request: Request) =>
  handler(request);

/** Routes `/assets/*` to the asset handler and everything else to the protocol, as `deco serve` does. */
export const route =
  (rpc: (request: Request) => Promise<Response>, assets: (request: Request) => Promise<Response>) =>
  (request: Request) =>
    new URL(request.url).pathname.startsWith("/assets/") ? assets(request) : rpc(request);

/** Limits low enough for the conformance suite to probe the list and batch-response bounds. */
export const PROBE_LIMITS = { maxListBytes: 256 * 1024, maxBatchResponseBytes: 384 * 1024 };
