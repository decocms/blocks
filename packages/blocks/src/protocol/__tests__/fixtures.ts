/**
 * Shared test fixtures: a small deco-meta@1 schema, and helpers to call a
 * handler in process.
 */
import type { DecoMeta } from "../types";

export const schemaFixture: DecoMeta = {
  manifest: {
    blocks: {
      sections: {
        hero: { $ref: "#/definitions/aGVybw==" },
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
      "c2V0dGluZ3M=": {
        type: "object",
        properties: {
          integrations: {
            type: "array",
            items: { type: "object", properties: { label: { type: "string" } } },
          },
        },
      },
      "bXY=": { type: "object", properties: { variants: { type: "array" } } },
      "bGF6eQ==": { type: "object", properties: { value: {} } },
    },
  },
};

/** Routes `/assets/*` to the asset handler and everything else to the protocol, as `deco serve` does. */
export const route =
  (rpc: (request: Request) => Promise<Response>, assets: (request: Request) => Promise<Response>) =>
  (request: Request) =>
    new URL(request.url).pathname.startsWith("/assets/") ? assets(request) : rpc(request);
