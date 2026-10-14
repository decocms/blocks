// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");

describe("the ./preview subpath", () => {
  it("package.json maps it to the source and the build", () => {
    expect(JSON.parse(read("../../../package.json")).exports["./preview"]).toEqual({
      types: "./dist/v8/preview/index.d.ts",
      source: "./src/v8/preview/index.ts",
      default: "./dist/v8/preview/index.js",
    });
  });

  it("exports exactly the documented runtime names", async () => {
    expect(Object.keys(await import("@decocms/blocks/preview")).sort()).toEqual([
      "DraftBadge",
      "StudioBridge",
    ]);
  });

  it("the badge's module is a client module; the bridge's has no hooks, so a Server Component renders it", () => {
    expect(read("./DraftBadge.tsx").startsWith('"use client";')).toBe(true);
    expect(read("./StudioBridge.ts")).not.toMatch(/use client|useEffect|useState|useRef/);
  });
});
