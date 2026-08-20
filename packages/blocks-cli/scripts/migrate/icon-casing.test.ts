import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileIconCasing } from "./phase-transform";
import { createContext, type MigrationContext } from "./types";

let dir: string;
let ctx: MigrationContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "icon-casing-"));
  mkdirSync(join(dir, "src", "components", "ui"), { recursive: true });
  mkdirSync(join(dir, "src", "sections"), { recursive: true });
  writeFileSync(
    join(dir, "src", "components", "ui", "Icon.tsx"),
    `export type AvailableIcons =\n  | "Close"\n  | "Menu"\n  | "ChevronDown";\n`,
  );
  ctx = createContext(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reconcileIconCasing", () => {
  it("case-corrects <Icon id> to match the declared AvailableIcons", () => {
    const f = join(dir, "src", "sections", "Drawer.tsx");
    writeFileSync(f, `<Icon id="close" /> <Icon id="menu" /> <Icon id="Close" />`);
    reconcileIconCasing(ctx);
    const out = readFileSync(f, "utf8");
    expect(out).toContain(`id="Close"`);
    expect(out).toContain(`id="Menu"`);
    expect(out).not.toContain(`id="close"`);
    expect(out).not.toContain(`id="menu"`);
  });

  it("flags a used icon that is NOT in AvailableIcons (no blind rename)", () => {
    const f = join(dir, "src", "sections", "Search.tsx");
    writeFileSync(f, `<Icon id="search" />`);
    reconcileIconCasing(ctx);
    // left as-is
    expect(readFileSync(f, "utf8")).toContain(`id="search"`);
    // flagged for manual review, once
    const flags = ctx.manualReviewItems.filter((m) => m.reason.includes(`id="search"`));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.file).toBe("src/sections/Search.tsx");
  });

  it("only touches <Icon id>, not other id= attributes", () => {
    const f = join(dir, "src", "sections", "Nav.tsx");
    writeFileSync(f, `<div id="close-button"><Icon id="close" /></div>`);
    reconcileIconCasing(ctx);
    const out = readFileSync(f, "utf8");
    expect(out).toContain(`<div id="close-button">`); // untouched
    expect(out).toContain(`<Icon id="Close" />`); // corrected
  });

  it("no-op when the site declares no AvailableIcons", () => {
    rmSync(join(dir, "src", "components", "ui", "Icon.tsx"));
    const f = join(dir, "src", "sections", "X.tsx");
    writeFileSync(f, `<Icon id="close" />`);
    reconcileIconCasing(ctx);
    expect(readFileSync(f, "utf8")).toContain(`id="close"`); // unchanged
  });
});
