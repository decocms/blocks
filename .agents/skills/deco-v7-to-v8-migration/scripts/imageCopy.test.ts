// @vitest-environment node
/**
 * A site's own copy of v7's image helper: the decoCdn options come from the
 * copy. The excerpts below are the lines that decide the URLs, verbatim from
 * `@decocms/blocks` 7.x `src/hooks/Image.tsx` (7.2.0 to 7.70.x, 7.71.0, 7.71.4,
 * 7.71.5/7.77.1), plus a storefront's edited copy (7.20.7 with 7.77.1's CDN
 * domain and decoims.com rule, but stripping asset hosts anywhere). Each
 * release's whole file, and both storefronts' copies, were fuzzed against
 * these options (VTEX, Shopify, Nuvemshop, Deco and other sources, four
 * registered domains): no URL differs but fix 2's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyDecoCdnOptions, findImageCopies, isImageCopy, readImageCopy } from "./imageCopy";
import { imageModule, releaseRules } from "./imageModule";
import { copyImageUrl, rewriteImports } from "./imports";
import { createReport } from "./report";

const PLATFORMS = `
	if (/(vteximg\\.com\\.br|vtexassets\\.com|myvtex\\.com)\\/arquivos\\/ids\\/\\d+/.test(originalSrc)) {
		return optimizeVTEX(originalSrc, width, height);
	}
	if (originalSrc.startsWith("https://cdn.shopify.com")) {
		return optimizeShopify(originalSrc, width, height);
	}`;
const CDN_PREFIX = `
	const cdnPrefix = \`https://\${imageCdnDomain}/\`;
	if (imageSource.startsWith(cdnPrefix)) {
		imageSource = imageSource.slice(cdnPrefix.length);
	}`;
const ANYWHERE = `const DECO_CACHE_URL = "https://assets.decocache.com/";
const S3_URL = "https://deco-sites-assets.s3.sa-east-1.amazonaws.com/";`;
const STRIP_ANYWHERE = `let imageSource = originalSrc.replace(DECO_CACHE_URL, "").replace(S3_URL, "").split("?")[0];`;
const DECOIMS_CLOUDFLARE = `const DECOIMS_PREFIX_RE = /^https:\\/\\/decoims\\.com\\//;
const CLOUDFLARE_CDNS = new Set(["assets.decocms.com", "decoims.com"]);`;

const copy = (head: string, domain: string, strip: string, extra = "") => `
import { forwardRef } from "react";
${head}
let imageCdnDomain = "${domain}";
export function registerImageCdnDomain(domain: string) {
	imageCdnDomain = domain.replace(/^https?:\\/\\//, "").replace(/\\/+$/, "");
}
/** \`registerImageQuality("80")\` — quality means 1-100 elsewhere. */
let imageQuality: ImageQuality | undefined;
export function registerImageQuality(quality: ImageQuality | undefined) {
	imageQuality = quality || undefined;
}
export function getOptimizedMediaUrl(opts: OptimizationOptions): string {
	const { originalSrc, width, height, fit } = opts;
	if (originalSrc.startsWith("data:")) return originalSrc;${PLATFORMS}${extra}
	${strip}${CDN_PREFIX}
	return \`https://\${imageCdnDomain}/image?\${params}&src=\${imageSource}\`;
}`;

const RELEASES = {
  "7.2.0": copy(ANYWHERE, "decoims.com", STRIP_ANYWHERE),
  "7.71.0": copy(ANYWHERE, "assets.decocms.com", STRIP_ANYWHERE),
  "7.71.4": copy(
    "const DECO_ASSET_PREFIX_RE =\n\t/^https:\\/\\/(?:assets\\.decocache\\.com|deco-sites-assets\\.s3\\.sa-east-1\\.amazonaws\\.com|decoims\\.com)\\//;",
    "assets.decocms.com",
    'let imageSource = originalSrc.replace(DECO_ASSET_PREFIX_RE, "").split("?")[0];',
  ),
  "7.77.1": copy(
    `const DECO_ASSET_PREFIX_RE =\n\t/^https:\\/\\/(?:assets\\.decocache\\.com|deco-sites-assets\\.s3\\.sa-east-1\\.amazonaws\\.com)\\//;\n${DECOIMS_CLOUDFLARE}`,
    "assets.decocms.com",
    'let imageSource = originalSrc.replace(DECO_ASSET_PREFIX_RE, "").split("?")[0];\n\tif (CLOUDFLARE_CDNS.has(imageCdnDomain)) imageSource = imageSource.replace(DECOIMS_PREFIX_RE, "");',
    "\n\tconst nuvemshop = originalSrc.match(NUVEMSHOP_IMAGE_RE); // *.mitiendanube.com\n\tif (nuvemshop) return optimizeNuvemshop(nuvemshop, width);",
  ),
  edited: copy(
    `${ANYWHERE}\n${DECOIMS_CLOUDFLARE}`,
    "assets.decocms.com",
    `${STRIP_ANYWHERE}\n\tif (CLOUDFLARE_CDNS.has(imageCdnDomain)) imageSource = imageSource.replace(DECOIMS_PREFIX_RE, "");`,
  ),
};

const options = (text: string, registered = {}) => {
  const rules = readImageCopy(text);
  if (!rules) throw new Error("not read");
  return copyDecoCdnOptions(rules, registered);
};

describe("a site's copy of v7's image helper", () => {
  it("is told apart from code that only uses the helper", () => {
    for (const text of Object.values(RELEASES)) expect(isImageCopy(text)).toBe(true);
    expect(isImageCopy('import { getOptimizedMediaUrl } from "@decocms/blocks/hooks";')).toBe(
      false,
    );
    expect(isImageCopy("const url = getOptimizedMediaUrl({ originalSrc });")).toBe(false);
  });

  it("gives the options each release's rules need, as the per-release table does", () => {
    expect(options(RELEASES["7.2.0"])).toBe('domain: "decoims.com", sources: "all"');
    expect(options(RELEASES["7.71.0"])).toBe('sources: "all", legacyHosts: []');
    expect(options(RELEASES["7.71.4"])).toBe('sources: "all", stripAssetHosts: "leading"');
    expect(options(RELEASES["7.77.1"])).toBe('sources: "all", stripAssetHosts: "leading"');
    expect(readImageCopy(RELEASES["7.77.1"])?.nuvemshop).toBe(true);
    expect(readImageCopy(RELEASES["7.71.4"])?.nuvemshop).toBe(false);
  });

  it("follows the domain and quality the site registers, and what each CDN needs for decoims.com", () => {
    const azion = { domain: "deco-assets.edgedeco.com" };
    expect(options(RELEASES["7.2.0"], azion)).toBe(
      'domain: "deco-assets.edgedeco.com", sources: "all"',
    );
    expect(options(RELEASES["7.71.4"], azion)).toBe(
      'domain: "deco-assets.edgedeco.com", sources: "all", stripAssetHosts: "leading", legacyHosts: ["decoims.com"]',
    );
    expect(options(RELEASES["7.77.1"], { domain: "decoims.com", quality: "high" })).toBe(
      'domain: "decoims.com", quality: "high", sources: "all", stripAssetHosts: "leading"',
    );
    expect(options(RELEASES["7.71.0"], { domain: null, quality: null })).toBe(
      'domain, quality, sources: "all", legacyHosts: []',
    );
  });

  it("an edited copy keeps its own rules, not its release's", () => {
    // 7.20.7's anywhere-stripping with 7.77.1's domain and decoims.com rule: decoCdn's defaults.
    expect(options(RELEASES.edited)).toBe('sources: "all"');
    const quality = RELEASES["7.2.0"].replace(
      "let imageQuality: ImageQuality | undefined;",
      'let imageQuality: ImageQuality | undefined = "high";',
    );
    expect(options(quality)).toBe('domain: "decoims.com", quality: "high", sources: "all"');
    expect(readImageCopy(RELEASES["7.2.0"].replace(/let imageCdnDomain = [^;]+;/, ""))).toBeNull();
    expect(readImageCopy(RELEASES["7.2.0"].replace(CDN_PREFIX, ""))).toBeNull();
  });
});

describe("the report for a site with its own copy", () => {
  let root: string | undefined;
  afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

  function site(files: Record<string, string>): string {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-v7-image-copy-")));
    for (const [file, data] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), data);
    }
    return root;
  }

  it("reads the options from the copy and the site's register calls, over the release's", () => {
    site({
      // The release table would say stripAssetHosts: "leading" for 7.77.1.
      "package.json": JSON.stringify({
        dependencies: { "@decocms/blocks": "7.77.1", "@decocms/tanstack": "7.77.1" },
      }),
      "src/vendor/blocks/Image.tsx": RELEASES.edited,
      "src/setup.ts":
        'import { registerImageCdnDomain, registerImageQuality } from "./vendor/blocks/Image";\n// registerImageQuality("80") would serve the lowest quality\nregisterImageCdnDomain("decoims.com");\nregisterImageQuality("high");\n',
      "src/Banner.tsx": 'import { Picture } from "@decocms/blocks/hooks";\n',
    });
    const found = findImageCopies(root as string);
    expect(found.copies.map((c) => c.file)).toEqual(["src/vendor/blocks/Image.tsx"]);
    expect(found.registered).toEqual({ domain: "decoims.com", quality: "high" });

    const report = createReport();
    rewriteImports(root as string, report, new Map());
    const note = (subject: string) => report.manual.find((n) => n.subject === subject)?.message;
    const want =
      'createImageUrl({ providers: [vtexCatalog(), shopifyCdn(), decoCdn({ domain: "decoims.com", quality: "high", sources: "all" })] })';
    expect(note("src/vendor/blocks/Image.tsx")).toContain(want);
    expect(note("src/vendor/blocks/Image.tsx")).toContain("re-resized from its src");
    // The site's src/imageUrl.ts is written with them.
    const module = fs.readFileSync(path.join(root as string, "src/imageUrl.ts"), "utf8");
    expect(module).toContain(
      'providers: [vtexCatalog(), shopifyCdn(), decoCdn({ domain: "decoims.com", quality: "high", sources: "all" })]',
    );
    expect(module).toContain("src/vendor/blocks/Image.tsx");
    expect(note("Image, Picture, Source")).toBeUndefined();
  });

  it("lists a copy's Nuvemshop provider, and says when it can't read a copy", () => {
    expect(
      copyImageUrl({ file: "src/Image.tsx", rules: readImageCopy(RELEASES["7.77.1"]) }),
    ).toContain(
      'providers: [vtexCatalog(), shopifyCdn(), nuvemshop, decoCdn({ sources: "all", stripAssetHosts: "leading" })]',
    );
    site({
      "package.json": JSON.stringify({ dependencies: { "@decocms/blocks": "7.64.3" } }),
      "src/sdk/image.ts": RELEASES["7.2.0"].replace(/let imageCdnDomain = [^;]+;/, ""),
    });
    const report = createReport();
    rewriteImports(root as string, report, new Map());
    expect(report.manual.find((n) => n.subject === "src/sdk/image.ts")?.message).toContain(
      "can't read",
    );
  });

  it("a site without a copy keeps the release's options", () => {
    site({
      "package.json": JSON.stringify({
        dependencies: { "@decocms/blocks": "7.77.1", "@decocms/tanstack": "7.77.1" },
      }),
      "src/Banner.tsx": 'import { Picture } from "@decocms/blocks/hooks";\n',
    });
    const report = createReport();
    rewriteImports(root as string, report, new Map());
    expect(fs.readFileSync(path.join(root as string, "src/imageUrl.ts"), "utf8")).toContain(
      'providers: [vtexCatalog(), shopifyCdn(), decoCdn({ sources: "all", stripAssetHosts: "leading" })]',
    );
    // 7.77.1 resized Nuvemshop images too, which no package covers.
    expect(report.manual.find((n) => n.subject === "src/imageUrl.ts")?.message).toContain(
      "Nuvemshop",
    );
  });

  it("can't write src/imageUrl.ts for a copy it can't read, or a registered value that isn't a literal", () => {
    site({
      "package.json": JSON.stringify({
        dependencies: { "@decocms/blocks": "7.77.1", "@decocms/tanstack": "7.77.1" },
      }),
      "src/Banner.tsx": 'import { Picture } from "@decocms/blocks/hooks";\n',
      "src/setup.ts":
        'import { registerImageCdnDomain } from "@decocms/blocks/hooks";\nregisterImageCdnDomain(process.env.CDN);\n',
    });
    const report = createReport();
    rewriteImports(root as string, report, new Map());
    expect(fs.existsSync(path.join(root as string, "src/imageUrl.ts"))).toBe(false);
    expect(report.manual.find((n) => n.subject === "Image, Picture, Source")?.message).toContain(
      "something other than one string literal",
    );
  });
});

describe("src/imageUrl.ts by 7.x release", () => {
  const REGISTERED = [
    {},
    { domain: "decoims.com" },
    { domain: "assets.decocms.com", quality: "high" },
    { domain: "deco-assets.edgedeco.com" },
    { quality: "medium" },
  ];

  it("gives each release the options its own Image's code needs (the verbatim excerpts above)", () => {
    for (const [version, text] of Object.entries(RELEASES)) {
      if (version === "edited") continue;
      const fromCode = readImageCopy(text)!;
      expect(releaseRules(version).nuvemshop, version).toBe(fromCode.nuvemshop);
      for (const registered of REGISTERED) {
        expect(copyDecoCdnOptions(releaseRules(version), registered), version).toBe(
          copyDecoCdnOptions(fromCode, registered),
        );
      }
    }
    // Between the excerpts' releases: the rules of the release before.
    expect(releaseRules("7.70.9")).toEqual(releaseRules("7.2.0"));
    expect(releaseRules("7.71.3")).toEqual(releaseRules("7.71.0"));
    expect(releaseRules("7.71.5")).toEqual({ ...releaseRules("7.77.1"), nuvemshop: false });
    expect(releaseRules(undefined)).toEqual(releaseRules("7.77.1"));
  });

  it("writes a module that imports what it lists", () => {
    const { text } = imageModule("7.64.3", { copies: [], registered: { quality: "high" } });
    expect(text).toContain('import { createImageUrl, decoCdn } from "@decocms/blocks/image";');
    expect(text).toContain('import { shopifyCdn } from "@decocms/apps-shopify/image";');
    expect(text).toContain('import { vtexCatalog } from "@decocms/apps-vtex/image";');
    expect(text).toContain(
      'providers: [vtexCatalog(), shopifyCdn(), decoCdn({ domain: "decoims.com", quality: "high", sources: "all" })]',
    );
    expect(text).toContain("v7 7.64.3's Image, with the site's registerImageQuality(\"high\")");
  });
});
