import { describe, expect, it } from "vitest";
import { setMetaData } from "@decocms/blocks-admin";
import { metaGET } from "./routeHandlers";

describe("routeHandlers (next)", () => {
  it("metaGET returns the schema response", async () => {
    setMetaData({ sections: {}, actions: {}, loaders: {} } as any);
    const response = await metaGET(new Request("https://example.com/live/_meta"));
    expect(response.status).toBe(200);
  });
});
