// @vitest-environment node
/**
 * The SDK reads one environment variable: `createCMS` defaults `dev` to
 * `NODE_ENV === "development"` (guarded, so `false` without `process`; an
 * explicit `dev` overrides it). Everything else is explicit `createCMS`
 * params (`site`, `token`, `interval`, `telemetry`, `preview`, `dev`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_READ =
  /\bprocess\b\s*\??\.\s*env\b|\{\s*env\s*\}\s*=\s*(globalThis\s*\??\.\s*)?process\b|Bun\s*\??\.\s*env\b|Deno\s*\??\.\s*env\b|import\.meta\.env|\.env\s*\[|\.env\s*\?\./;
const ALLOWED: { file: string; line: string }[] = [
  // deco serve's git child process inherits the environment (PATH, HOME), minus
  // the GIT_* variables that would point it at another repository. Nothing is read.
  {
    file: "protocol/storage/fs/git.ts",
    line: "const env: NodeJS.ProcessEnv = { ...process.env };",
  },
  // createCMS's `dev` default, the one exception (see isDevelopment in cms.ts).
  {
    file: "v8/cms.ts",
    line: 'typeof process !== "undefined" && process.env != null && process.env.NODE_ENV === "development"',
  },
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
  it("the guard catches every spelling of an env read", () => {
    for (const read of [
      "process.env.X",
      "process?.env.X",
      "globalThis.process?.env.X",
      "const { env } = process;",
      "const { env } = globalThis.process;",
      "Bun.env.X",
      "Deno.env.get('X')",
      "import.meta.env.X",
      "globalThis.env?.X",
    ]) {
      expect(ENV_READ.test(read), read).toBe(true);
    }
  });

  it("packages/blocks/src reads none but NODE_ENV, once, for createCMS's dev default", () => {
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
});
