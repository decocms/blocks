// @vitest-environment node
/**
 * The SDK reads no environment variable: configuration is explicit
 * `createCMS` params (`site`, `token`, `interval`, `telemetry`, `preview`).
 * The one exception is `NODE_ENV=development` in remoteLoader.ts, which keeps
 * local development off hosted releases (local files win).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_READ = /process\s*\.\s*env|Deno\s*\.\s*env|import\.meta\.env|\.env\s*\[|\.env\s*\?\./;
const ALLOWED = [
  { file: "v8/remoteLoader.ts", line: 'return process.env.NODE_ENV === "development";' },
];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name.startsWith("__") ? [] : sources(full);
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return entry.name === "testFixtures.ts" ? [] : [full];
  });
}

describe("no environment variables", () => {
  it("packages/blocks/src reads none, except NODE_ENV=development in remoteLoader.ts", () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((text, index) => {
          if (!ENV_READ.test(text) || text.trim().startsWith("//") || text.trim().startsWith("*")) {
            return;
          }
          if (ALLOWED.some((a) => a.file === rel && text.trim() === a.line)) return;
          hits.push(`${rel}:${index + 1}: ${text.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("the NODE_ENV exception is still there, exactly once", () => {
    const source = fs.readFileSync(path.join(SRC, "v8/remoteLoader.ts"), "utf8");
    expect(source.split(ALLOWED[0]!.line).length - 1).toBe(1);
  });
});
