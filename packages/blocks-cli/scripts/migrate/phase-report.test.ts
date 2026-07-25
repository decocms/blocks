import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { report } from "./phase-report";
import { createContext } from "./types";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-report-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("report — CSS Migration section", () => {
  it("summarizes tokens ported from tailwind.config.ts", () => {
    const ctx = createContext(tmpDir);
    ctx.tailwindConfig = {
      colors: { perola: "#F5F0E8", "brand-500": "#B10200" },
      fontFamily: { "bebas-neue": "Bebas Neue, sans-serif" },
      screens: {},
      safelist: ["bg-red-500"],
      safelistPatterns: [],
      plugins: [],
      reviewItems: [],
    };

    report(ctx);

    const content = fs.readFileSync(path.join(tmpDir, "MIGRATION_REPORT.md"), "utf-8");
    expect(content).toContain("## CSS Migration");
    expect(content).toContain("2 color(s), 1 font stack(s), 0 breakpoint(s)");
    expect(content).toContain("1 safelist entrie(s)");
  });

  it("lists CSS-specific manual review items separately from unrelated ones", () => {
    const ctx = createContext(tmpDir);
    ctx.manualReviewItems = [
      {
        file: "src/styles/app.css",
        reason: "safelist pattern /^grid-cols-/ cannot be auto-converted",
        severity: "warning",
      },
      {
        file: "src/components/Foo.tsx",
        reason: "useComponent(...) call site detected — needs manual React conversion",
        severity: "error",
      },
    ];

    report(ctx);

    const content = fs.readFileSync(path.join(tmpDir, "MIGRATION_REPORT.md"), "utf-8");
    const cssSection = content.split("## CSS Migration")[1].split("## Always Check")[0];
    expect(cssSection).toContain("safelist pattern");
    expect(cssSection).not.toContain("useComponent");
  });

  it("reports no CSS findings when none exist", () => {
    const ctx = createContext(tmpDir);
    report(ctx);
    const content = fs.readFileSync(path.join(tmpDir, "MIGRATION_REPORT.md"), "utf-8");
    expect(content).toContain("No CSS-specific findings from this run.");
  });
});
