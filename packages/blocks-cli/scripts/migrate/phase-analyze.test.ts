import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractGoogleFonts, extractPlatform } from "./phase-analyze";

// `extractPlatform` runs four strategies in order:
//   1. deno.json imports referencing apps/{platform}/
//   2. apps/{platform}.ts file existence
//   3. apps/site.ts loose string match against platform name + "platform"
//   4. .deco/blocks filenames hinting at platform
// Strategy 3 is the false-positive trap that ate Magento sites before #211:
// helsinki/granadobr's apps/site.ts imports `apps/vtex/mod.ts` for the color
// palette, so the content matches `"vtex"` even though the real platform is
// declared via `apps/magento.ts`. The fix adds "magento" to the platforms
// list so Strategy 2 fires first and short-circuits before Strategy 3 can
// over-match.

describe("extractGoogleFonts", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extract-gfonts-"));
    fs.mkdirSync(path.join(tmp, "routes"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("extracts preconnects and stylesheet from _app.tsx", () => {
    fs.writeFileSync(
      path.join(tmp, "routes", "_app.tsx"),
      `<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" />`,
    );
    const result = extractGoogleFonts(tmp);
    expect(result.preconnects).toEqual([
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
    ]);
    expect(result.stylesheets).toEqual([
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap",
    ]);
  });

  it("deduplicates URLs present in both _app.tsx and _layout.tsx", () => {
    const sharedUrl = "https://fonts.googleapis.com/css2?family=Roboto&display=swap";
    fs.writeFileSync(
      path.join(tmp, "routes", "_app.tsx"),
      `<link rel="stylesheet" href="${sharedUrl}" />`,
    );
    fs.writeFileSync(
      path.join(tmp, "routes", "_layout.tsx"),
      `<link rel="stylesheet" href="${sharedUrl}" />`,
    );
    const result = extractGoogleFonts(tmp);
    expect(result.stylesheets).toHaveLength(1);
  });

  it("extracts Google Fonts @import from tailwind.css", () => {
    fs.writeFileSync(
      path.join(tmp, "tailwind.css"),
      `@import url('https://fonts.googleapis.com/css2?family=Poppins&display=swap');`,
    );
    const result = extractGoogleFonts(tmp);
    expect(result.stylesheets).toEqual([
      "https://fonts.googleapis.com/css2?family=Poppins&display=swap",
    ]);
  });

  it("returns empty arrays when no Google Fonts are declared", () => {
    fs.writeFileSync(path.join(tmp, "routes", "_app.tsx"), `<link rel="icon" href="/favicon.ico" />`);
    const result = extractGoogleFonts(tmp);
    expect(result.preconnects).toHaveLength(0);
    expect(result.stylesheets).toHaveLength(0);
  });
});

describe("extractPlatform", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extract-platform-"));
    fs.mkdirSync(path.join(tmp, "apps"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("detects magento from apps/magento.ts (granadobr/helsinki shape)", () => {
    fs.writeFileSync(path.join(tmp, "apps", "magento.ts"), "export default {};\n");
    // Also write a site.ts that imports vtex for color palettes — this is
    // what tripped Strategy 3 before #211.
    fs.writeFileSync(
      path.join(tmp, "apps", "site.ts"),
      `import { color as vtex } from "apps/vtex/mod.ts";\n` +
        `export interface State { platform: string }\n`,
    );
    expect(extractPlatform(tmp)).toBe("magento");
  });

  it("detects vtex from apps/vtex.ts", () => {
    fs.writeFileSync(path.join(tmp, "apps", "vtex.ts"), "export default { account: \"foo\" };\n");
    expect(extractPlatform(tmp)).toBe("vtex");
  });

  it("falls back to custom when no platform signal exists", () => {
    fs.writeFileSync(path.join(tmp, "apps", "site.ts"), "export default {};\n");
    expect(extractPlatform(tmp)).toBe("custom");
  });

  it("prefers magento over vtex when both an apps/magento.ts AND a vtex string match exist", () => {
    // Reproduce the exact granadobr trap: apps/magento.ts is the real signal,
    // but apps/site.ts loosely contains "vtex" + "platform".
    fs.writeFileSync(path.join(tmp, "apps", "magento.ts"), "export default {};\n");
    fs.writeFileSync(
      path.join(tmp, "apps", "site.ts"),
      `import "apps/vtex/mod.ts";\nexport interface State { platform: string }\n`,
    );
    expect(extractPlatform(tmp)).toBe("magento");
  });
});
