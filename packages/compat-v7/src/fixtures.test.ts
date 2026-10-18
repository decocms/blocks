// @vitest-environment node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { V7_COMMIT, V7_FILES } from "./__tests__/v7";

const dir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/v7");

describe(`the v7 reference code (7.x at ${V7_COMMIT})`, () => {
  it("is v7's files byte for byte (pinned hashes), and nothing else", () => {
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(dir, join(e.parentPath, e.name)))
      .sort();
    expect(files).toEqual(Object.keys(V7_FILES).sort());
    for (const [file, hash] of Object.entries(V7_FILES)) {
      const actual = createHash("sha256")
        .update(readFileSync(join(dir, file)))
        .digest("hex");
      expect([file, actual]).toEqual([file, hash]);
    }
  });
});
