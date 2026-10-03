// @vitest-environment node
/** kvLoader (api-reference#loaders, hosted-publishing#large-content-on-workers). */
import { createCMS, resetForTests, type Snapshot } from "@decocms/blocks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kvLoader } from "./kvLoader";

const snapshot: Snapshot = {
  revision: "rev-kv",
  blocks: { Banner: { __resolveType: "banner", title: "From KV" } },
};

beforeEach(() => resetForTests());

describe("kvLoader", () => {
  it("serves the snapshot stored under the key, read once per isolate", async () => {
    const get = vi.fn(async () => snapshot);
    const loader = kvLoader({ get }, { key: "content" });
    const cms = createCMS({ blocks: { banner: (p: { title: string }) => p }, content: loader });
    expect(await cms.forRelease().resolve("Banner")).toEqual([{ title: "From KV" }, null]);
    expect(await cms.forRelease().revision()).toBe("rev-kv");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("content", "json");
  });

  it("a missing key fails with LOADER_FAILED and is read again next time", async () => {
    const get = vi.fn(async () => null as unknown);
    const cms = createCMS({ blocks: {}, content: kvLoader({ get }, { key: "content" }) });
    const [, error] = await cms.forRelease().resolve("Banner");
    expect(error?.code).toBe("LOADER_FAILED");
    get.mockResolvedValueOnce(snapshot);
    expect(await cms.forRelease().revision()).toBe("rev-kv");
  });
});
