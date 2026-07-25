import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractTailwindConfig } from "./tailwind-config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(content: string) {
  fs.writeFileSync(path.join(tmpDir, "tailwind.config.ts"), content, "utf-8");
}

describe("extractTailwindConfig", () => {
  it("returns an empty extract when no config file exists", () => {
    const result = extractTailwindConfig(tmpDir);
    expect(result.colors).toEqual({});
    expect(result.reviewItems).toEqual([]);
  });

  it("flattens nested theme.extend.colors into dash-joined tokens", () => {
    writeConfig(`
      export default {
        theme: {
          extend: {
            colors: {
              perola: "#F5F0E8",
              brand: {
                100: "#FFEFEF",
                500: "#B10200",
              },
            },
          },
        },
      };
    `);

    const result = extractTailwindConfig(tmpDir);
    expect(result.colors).toEqual({
      perola: "#F5F0E8",
      "brand-100": "#FFEFEF",
      "brand-500": "#B10200",
    });
    expect(result.reviewItems).toEqual([]);
  });

  it("joins fontFamily array literals with a comma", () => {
    writeConfig(`
      export default {
        theme: {
          extend: {
            fontFamily: {
              sans: ["Bebas Neue", "sans-serif"],
            },
          },
        },
      };
    `);

    const result = extractTailwindConfig(tmpDir);
    expect(result.fontFamily.sans).toBe("Bebas Neue, sans-serif");
  });

  it("splits safelist into literal strings and regex patterns", () => {
    writeConfig(`
      export default {
        safelist: ["bg-red-500", /^grid-cols-/],
      };
    `);

    const result = extractTailwindConfig(tmpDir);
    expect(result.safelist).toEqual(["bg-red-500"]);
    expect(result.safelistPatterns).toEqual(["/^grid-cols-/"]);
  });

  it("flags non-literal color entries as review items instead of dropping silently", () => {
    writeConfig(`
      const shared = { accent: "#000" };
      export default {
        theme: {
          extend: {
            colors: {
              ...shared,
              primary: someFn(),
            },
          },
        },
      };
    `);

    const result = extractTailwindConfig(tmpDir);
    expect(result.colors.primary).toBeUndefined();
    expect(result.reviewItems.length).toBeGreaterThan(0);
    expect(result.reviewItems[0].severity).toBe("warning");
  });

  it("supports module.exports = {...} form", () => {
    writeConfig(`
      module.exports = {
        theme: { extend: { colors: { primary: "#111111" } } },
      };
    `);

    const result = extractTailwindConfig(tmpDir);
    expect(result.colors).toEqual({ primary: "#111111" });
  });

  it("reports an error review item when the export shape is unrecognized", () => {
    writeConfig(`
      const config = buildConfig();
      export default config;
    `);

    const result = extractTailwindConfig(tmpDir);
    expect(result.colors).toEqual({});
    expect(result.reviewItems.some((r) => r.severity === "error")).toBe(true);
  });
});
