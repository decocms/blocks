import { describe, expect, it } from "vitest";
import { _internals } from "./rules";
import type { FsAdapter, FsWriter } from "./types";

const {
  ruleStringStyleProps,
  ruleFreshAssetCalls,
  ruleImportMetaResolve,
  ruleUndeclaredPlatformGlobal,
  ruleCtxRuntimeApiResidue,
  ruleDuplicateImports,
  ruleCorruptedTernaries,
  ruleBrokenTemplateLiterals,
  ruleTailwindPaletteDropped,
} = _internals.rules;

function makeFs(files: Record<string, string>): FsAdapter {
  const norm = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k.replace(/\\/g, "/"), v]),
  );
  return {
    exists(absPath) {
      return absPath.replace(/\\/g, "/") in norm;
    },
    readText(absPath) {
      const key = absPath.replace(/\\/g, "/");
      if (!(key in norm)) throw new Error(`ENOENT: ${absPath}`);
      return norm[key];
    },
    glob(siteDir, pattern, excludeDirs = []) {
      const root = siteDir.replace(/\\/g, "/");
      const all = Object.keys(norm).filter((p) => p.startsWith(`${root}/`));
      const filtered = all.filter((p) => {
        const rel = p.slice(root.length + 1);
        return !excludeDirs.some((dir) => rel.startsWith(`${dir}/`));
      });
      const branches = pattern.includes("{")
        ? pattern
            .match(/\{([^{}]+)\}/)![1]
            .split(",")
            .map((b) => pattern.replace(/\{[^{}]+\}/, b.trim()))
        : [pattern];
      const regexes = branches.map((p) => {
        const re = p
          .replace(/[.+^$()|]/g, "\\$&")
          .replace(/\*\*\//g, "<<DBL>>")
          .replace(/\*\*/g, "<<DBL>>")
          .replace(/\*/g, "[^/]*")
          .replace(/<<DBL>>/g, "(?:.*/)?");
        return new RegExp(`^${re}$`);
      });
      return filtered
        .filter((p) => {
          const rel = p.slice(root.length + 1);
          return regexes.some((re) => re.test(rel));
        })
        .sort();
    },
  };
}

function makeWriter(fs: FsAdapter): FsWriter & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  return {
    written,
    deleteFile(absPath) {
      delete written[absPath];
    },
    writeText(absPath, content) {
      written[absPath] = content;
      (fs as any).__norm ??= {};
    },
  };
}

const SITE = "/site";

describe("ruleStringStyleProps (#369)", () => {
  it("flags string style props", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/Slide.tsx`]: `<div style="a: b">x</div>`,
    });
    const findings = ruleStringStyleProps.run({ siteDir: SITE, fs });
    expect(findings).toHaveLength(1);
    expect(findings[0].meta?.count).toBe(1);
  });

  it("does not flag object style props", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/Slide.tsx`]: `<div style={{ a: "b" }}>x</div>`,
    });
    expect(ruleStringStyleProps.run({ siteDir: SITE, fs })).toEqual([]);
  });
});

describe("ruleFreshAssetCalls (#369)", () => {
  it("flags asset() calls with no local declaration", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/Fonts.tsx`]: `const href = asset(font.source);`,
    });
    expect(ruleFreshAssetCalls.run({ siteDir: SITE, fs })).toHaveLength(1);
  });

  it("ignores a locally-declared asset() helper", () => {
    const fs = makeFs({
      [`${SITE}/src/utils/asset.ts`]: `export function asset(x: string) { return x; }`,
    });
    expect(ruleFreshAssetCalls.run({ siteDir: SITE, fs })).toEqual([]);
  });
});

describe("ruleImportMetaResolve (#369)", () => {
  it("flags import.meta.resolve calls", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/Searchbar.tsx`]: `const url = import.meta.resolve("./x");`,
    });
    expect(ruleImportMetaResolve.run({ siteDir: SITE, fs })).toHaveLength(1);
  });
});

describe("ruleUndeclaredPlatformGlobal (#369)", () => {
  it("flags a bare `platform` reference with no import/declaration", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/Cart.tsx`]: `if (platform === "vtex") { doThing(); }`,
    });
    expect(ruleUndeclaredPlatformGlobal.run({ siteDir: SITE, fs })).toHaveLength(1);
  });

  it("ignores platform when imported", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/Cart.tsx`]: `import { platform } from "~/apps/storefront";\nif (platform === "vtex") {}`,
    });
    expect(ruleUndeclaredPlatformGlobal.run({ siteDir: SITE, fs })).toEqual([]);
  });
});

describe("ruleCtxRuntimeApiResidue (#369)", () => {
  it("flags ctx.get({ __resolveType and ctx.response", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/ProductShelf.tsx`]: `const x = ctx.get({ __resolveType: "resolvables" });`,
      [`${SITE}/src/sections/Theme.tsx`]: `ctx.response.headers.set("x", "y");`,
    });
    const findings = ruleCtxRuntimeApiResidue.run({ siteDir: SITE, fs });
    expect(findings).toHaveLength(2);
  });
});

describe("ruleDuplicateImports (#369)", () => {
  it("flags the same identifier imported twice", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/SearchResult.tsx`]: [
        `import { ImageWidget } from "site/types.ts";`,
        `import { ImageWidget } from "site/other.ts";`,
        `export const x = 1;`,
      ].join("\n"),
    });
    const findings = ruleDuplicateImports.run({ siteDir: SITE, fs });
    expect(findings).toHaveLength(1);
    expect(findings[0].meta?.identifiers).toEqual(["ImageWidget"]);
  });

  it("applyFix removes the redundant import line", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/SearchResult.tsx`]: [
        `import { ImageWidget } from "site/types.ts";`,
        `import { ImageWidget } from "site/other.ts";`,
        `export const x = 1;`,
      ].join("\n"),
    });
    const findings = ruleDuplicateImports.run({ siteDir: SITE, fs });
    const writer = makeWriter(fs);
    const actions = ruleDuplicateImports.applyFix!({ siteDir: SITE, fs }, findings, writer);
    expect(actions).toHaveLength(1);
    const updated = writer.written[`${SITE}/src/sections/SearchResult.tsx`];
    expect(updated).toContain(`import { ImageWidget } from "site/types.ts";`);
    expect(updated).not.toContain(`from "site/other.ts"`);
  });

  it("does not flag distinct identifiers", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/X.tsx`]: [
        `import { A } from "a";`,
        `import { B } from "b";`,
      ].join("\n"),
    });
    expect(ruleDuplicateImports.run({ siteDir: SITE, fs })).toEqual([]);
  });
});

describe("ruleCorruptedTernaries (#369)", () => {
  it("flags a corrupted ternary in a template literal", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/Filters.tsx`]: "const c = `foo ${a ? \"x\"} : \"y\"}`;",
    });
    const findings = ruleCorruptedTernaries.run({ siteDir: SITE, fs });
    expect(findings).toHaveLength(1);
    expect(findings[0].meta?.count).toBe(1);
  });

  it("applyFix repairs the ternary", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/Filters.tsx`]: "const c = `foo ${a ? \"x\"} : \"y\"}`;",
    });
    const findings = ruleCorruptedTernaries.run({ siteDir: SITE, fs });
    const writer = makeWriter(fs);
    ruleCorruptedTernaries.applyFix!({ siteDir: SITE, fs }, findings, writer);
    const updated = writer.written[`${SITE}/src/sections/Filters.tsx`];
    expect(updated).toBe('const c = `foo ${a ? "x" : "y"}`;');
  });

  it("does not flag a correct ternary", () => {
    const fs = makeFs({
      [`${SITE}/src/sections/Filters.tsx`]: 'const c = `foo ${a ? "x" : "y"}`;',
    });
    expect(ruleCorruptedTernaries.run({ siteDir: SITE, fs })).toEqual([]);
  });
});

describe("ruleBrokenTemplateLiterals (#369)", () => {
  it('flags `${await ""}`', () => {
    const fs = makeFs({
      [`${SITE}/src/sections/Fonts.tsx`]: '`/styles.css?revision=${await ""}`;',
    });
    expect(ruleBrokenTemplateLiterals.run({ siteDir: SITE, fs })).toHaveLength(1);
  });
});

describe("ruleTailwindPaletteDropped (#369)", () => {
  it("flags a custom color missing from the v4 @theme block", () => {
    const fs = makeFs({
      [`${SITE}/tailwind.config.ts`]: `export default {
  theme: {
    extend: {
      colors: {
        perola: "#efe9e2",
        "perola-intermediario": "#d8cfc2",
      },
    },
  },
};`,
      [`${SITE}/src/app.css`]: `@theme {\n  --color-*: initial;\n}`,
    });
    const findings = ruleTailwindPaletteDropped.run({ siteDir: SITE, fs });
    expect(findings).toHaveLength(1);
    expect(findings[0].meta?.missing).toEqual(["perola", "perola-intermediario"]);
  });

  it("does not flag when every custom color is present in @theme", () => {
    const fs = makeFs({
      [`${SITE}/tailwind.config.ts`]: `export default {
  theme: { extend: { colors: { perola: "#efe9e2" } } },
};`,
      [`${SITE}/src/app.css`]: `@theme {\n  --color-perola: #efe9e2;\n}`,
    });
    expect(ruleTailwindPaletteDropped.run({ siteDir: SITE, fs })).toEqual([]);
  });

  it("is a no-op without a tailwind.config file", () => {
    const fs = makeFs({ [`${SITE}/src/app.css`]: `@theme {}` });
    expect(ruleTailwindPaletteDropped.run({ siteDir: SITE, fs })).toEqual([]);
  });
});
