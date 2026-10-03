/**
 * Shared test fixtures: a small deco-meta@1 schema with a Secret field, and
 * helpers to call a handler in process.
 */
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

export const CIPHERTEXT = "v1.QUJDREVG.Z2hpamts";

export const secretBlock = (ciphertext = CIPHERTEXT) => ({ __resolveType: "secret", ciphertext });

/** A fetch that calls `handler` in process. */
export const inProcess = (handler: (request: Request) => Promise<Response>) => (request: Request) =>
  handler(request);
