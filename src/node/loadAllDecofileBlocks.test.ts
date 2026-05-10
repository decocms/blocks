import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllDecofileBlocks } from "./loadAllDecofileBlocks";

describe("loadAllDecofileBlocks", () => {
  it("loads all .json files into a map keyed by decoded filename", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "deco-blocks-"));
    try {
      writeFileSync(join(tmp, "site%2Fpages%2FHome.json"), '{"name":"home"}');
      writeFileSync(join(tmp, "ignored.txt"), "not json");
      const result = await loadAllDecofileBlocks(tmp);
      expect(result["site/pages/Home"]).toEqual({ name: "home" });
      expect(Object.keys(result).length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips malformed JSON with a warning", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "deco-blocks-"));
    try {
      writeFileSync(join(tmp, "good.json"), '{"ok":true}');
      writeFileSync(join(tmp, "bad.json"), "{not valid json");
      const result = await loadAllDecofileBlocks(tmp);
      expect(result.good).toEqual({ ok: true });
      expect(result.bad).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns empty object when directory does not exist", async () => {
    const result = await loadAllDecofileBlocks("/this/path/does/not/exist/at/all");
    expect(result).toEqual({});
  });
});
