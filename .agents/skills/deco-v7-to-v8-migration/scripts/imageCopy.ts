/**
 * A site's own copy of v7's image helper (`hooks/Image.tsx` from
 * `@decocms/blocks` 7.x, vendored into `src/` and sometimes edited): its URLs
 * are what the site serves, so the `decoCdn` options that reproduce them are
 * read from the copy, not from the release the site's `package.json` names.
 * The rules read are the ones that changed across 7.x releases (or that a
 * site edited): the CDN domain and quality it starts with, whether the Deco
 * asset hosts are stripped anywhere or only at the start, how decoims.com
 * sources are treated, and Nuvemshop's fixed sizes.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SOURCE = /\.(tsx?|mts|cts)$/;
const CLOUDFLARE_CDNS = new Set(["assets.decocms.com", "decoims.com"]);
const DEFAULT_DOMAIN = "assets.decocms.com";

export interface ImageCopyRules {
  /** `imageCdnDomain`'s initial value. */
  domain: string;
  /** `imageQuality`'s initial value, if any. */
  quality?: string;
  /** `"anywhere"`: `.replace(DECO_CACHE_URL, "")`; `"leading"`: an anchored regex. */
  stripAssetHosts: "anywhere" | "leading";
  /**
   * decoims.com sources: `"none"` (kept whole), `"cloudflare"` (stripped on
   * the Cloudflare CDNs, v7 from 7.71.5), `"always"` (in the anchored asset
   * regex, v7 7.71.4).
   */
  decoims: "none" | "cloudflare" | "always";
  /** v7's VTEX catalog rule (`vtexCatalog()`), Shopify's (`shopifyCdn()`), Nuvemshop's fixed sizes. */
  vtex: boolean;
  shopify: boolean;
  nuvemshop: boolean;
}

export interface ImageCopy {
  /** Path from the site root. */
  file: string;
  /** The rules read from the copy, or null when it doesn't have v7's shape. */
  rules: ImageCopyRules | null;
}

const stripScheme = (d: string) => d.replace(/^https?:\/\//, "").replace(/\/+$/, "");

/** Whether `text` defines v7's image helper (not just imports it). */
export function isImageCopy(text: string): boolean {
  return (
    /(?:function\s+getOptimizedMediaUrl\b|\bgetOptimizedMediaUrl\s*=\s*(?:\(|function))/.test(
      text,
    ) && /assets\\?\.decocache\\?\.com/.test(text)
  );
}

/** The URL rules of a copy of v7's image helper, or null when they can't be read. */
export function readImageCopy(text: string): ImageCopyRules | null {
  const domain = /\blet\s+imageCdnDomain(?:\s*:\s*[^=]+)?\s*=\s*["'`]([^"'`]+)["'`]/.exec(
    text,
  )?.[1];
  if (!domain) return null;
  // The CDN's own URLs are always shown relative; a copy without that check is not v7's.
  if (!/startsWith\(\s*(?:cdnPrefix|`https:\/\/\$\{imageCdnDomain\}\/`)\s*\)/.test(text))
    return null;
  const anchored = /\^https:\\\/\\\/\(\?:assets\\\.decocache\\\.com[^/\n]*/.exec(text)?.[0];
  const anywhere =
    /\.replace\(\s*(?:DECO_CACHE_URL|["'`]https:\/\/assets\.decocache\.com\/["'`])\s*,/.test(text);
  if (!anchored && !anywhere) return null;
  const quality = /\blet\s+imageQuality(?:\s*:\s*[^=]+)?\s*=\s*["'`](\w+)["'`]/.exec(text)?.[1];
  const decoims =
    anchored?.includes("decoims\\.com") === true
      ? "always"
      : /CLOUDFLARE_CDNS\.has\(\s*imageCdnDomain\s*\)/.test(text) && /decoims\\\.com/.test(text)
        ? "cloudflare"
        : /decoims\\\.com/.test(text)
          ? null
          : "none";
  if (decoims === null) return null;
  return {
    domain: stripScheme(domain),
    ...(quality ? { quality } : {}),
    stripAssetHosts: anchored ? "leading" : "anywhere",
    decoims,
    vtex: /vteximg|vtexassets/.test(text),
    shopify: text.includes("cdn.shopify.com"),
    nuvemshop: text.includes("mitiendanube"),
  };
}

/**
 * The `decoCdn` options (besides the providers' order) that reproduce a
 * copy's URLs. `registered` is what the site passes the copy's
 * `registerImageCdnDomain`/`registerImageQuality` (a string literal), which
 * overrides the copy's initial values; `null` when it passes something else,
 * left as `domain`/`quality` for a person to fill in.
 */
export function copyDecoCdnOptions(
  rules: ImageCopyRules,
  registered: { domain?: string | null; quality?: string | null } = {},
): string {
  const parts: string[] = [];
  const domain = registered.domain === undefined ? rules.domain : registered.domain;
  if (domain === null) parts.push("domain");
  else if (stripScheme(domain) !== DEFAULT_DOMAIN) parts.push(`domain: "${stripScheme(domain)}"`);
  const quality = registered.quality === undefined ? rules.quality : registered.quality;
  if (quality === null) parts.push("quality");
  else if (quality) parts.push(`quality: "${quality}"`);
  parts.push('sources: "all"');
  // stripAssetHosts is left at decoCdn's default, "leading", for every copy: a
  // copy that stripped the asset hosts anywhere moves to "leading" too
  // (approved, PO 2026-10-15), and `leadingStripChanges` counts the URLs that changes.
  // decoCdn's default: decoims.com on the Cloudflare CDNs (but not the CDN's own host).
  if (domain !== null) {
    const host = stripScheme(domain);
    const fallback = CLOUDFLARE_CDNS.has(host) && host !== "decoims.com" ? ["decoims.com"] : [];
    const copy =
      rules.decoims === "none"
        ? []
        : rules.decoims === "always"
          ? host === "decoims.com"
            ? []
            : ["decoims.com"]
          : fallback;
    if (copy.join() !== fallback.join()) parts.push(`legacyHosts: ${JSON.stringify(copy)}`);
  } else if (rules.decoims !== "cloudflare") {
    parts.push(rules.decoims === "none" ? "legacyHosts: []" : 'legacyHosts: ["decoims.com"]');
  }
  return parts.join(", ");
}

function listSources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && SOURCE.test(d.name) && !d.name.endsWith(".d.ts"))
    .map((d) => path.join(d.parentPath, d.name))
    .filter((f) => !f.split(path.sep).includes("node_modules") && !/\.test\.tsx?$/.test(f))
    .sort();
}

/**
 * What the site's code passes to `name(…)`: the string literal, null for
 * anything else (or different values), undefined when it is never called.
 */
function registeredValue(files: ts.SourceFile[], name: string): string | null | undefined {
  const values = new Set<string | null>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const called = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (called === name) {
        const [arg] = node.arguments;
        values.add(arg && ts.isStringLiteralLike(arg) ? arg.text : null);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of files) visit(file);
  if (values.size === 0) return undefined;
  return values.size === 1 ? [...values][0] : null;
}

/** The site's copies of v7's image helper under `src/`, in path order. */
export function findImageCopies(root: string): {
  copies: ImageCopy[];
  registered: { domain?: string | null; quality?: string | null };
} {
  const parsed: ts.SourceFile[] = [];
  const copies: ImageCopy[] = [];
  for (const file of listSources(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    if (/registerImage(?:CdnDomain|Quality)\(/.test(text)) {
      parsed.push(
        ts.createSourceFile(
          file,
          text,
          ts.ScriptTarget.Latest,
          false,
          file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        ),
      );
    }
    if (isImageCopy(text)) {
      copies.push({
        file: path.relative(root, file).split(path.sep).join("/"),
        rules: readImageCopy(text),
      });
    }
  }
  return {
    copies,
    registered: {
      domain: registeredValue(parsed, "registerImageCdnDomain"),
      quality: registeredValue(parsed, "registerImageQuality"),
    },
  };
}

const DECO_CACHE_URL = "https://assets.decocache.com/";
const DECO_S3_URL = "https://deco-sites-assets.s3.sa-east-1.amazonaws.com/";
const LEADING_ASSET_HOST =
  /^https:\/\/(?:assets\.decocache\.com|deco-sites-assets\.s3\.sa-east-1\.amazonaws\.com)\//;
const URL_IN_TEXT = /https?:\/\/[^\s"'`<>()\\]+/g;

/**
 * Whether decoCdn's `stripAssetHosts: "leading"` (its default) gives `src` a
 * different source than v7's strip-anywhere did (`.replace(DECO_CACHE_URL, "")`,
 * then the S3 bucket): true for a URL that merely contains an asset URL,
 * such as `https://other.host/https://assets.decocache.com/…`.
 */
export function changedByLeadingStrip(src: string): boolean {
  // Both drop the query afterwards, as decoCdn does.
  const anywhere = src.replace(DECO_CACHE_URL, "").replace(DECO_S3_URL, "").split("?")[0];
  return anywhere !== src.replace(LEADING_ASSET_HOST, "").split("?")[0];
}

export interface LeadingStripChange {
  /** Path from the site root. */
  file: string;
  url: string;
}

function stringsOf(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) stringsOf(v, out);
  return out;
}

/**
 * The URLs in the saved content (`.deco/blocks`) and in `src/` whose image
 * source changes when the asset hosts are stripped only at the start, for a
 * site whose v7 image code stripped them anywhere. One entry per URL and file.
 */
export function leadingStripChanges(root: string): LeadingStripChange[] {
  const found: LeadingStripChange[] = [];
  const seen = new Set<string>();
  const add = (file: string, texts: string[]) => {
    const rel = path.relative(root, file).split(path.sep).join("/");
    for (const text of texts) {
      if (!text.includes(DECO_CACHE_URL) && !text.includes(DECO_S3_URL)) continue;
      for (const [url] of text.matchAll(URL_IN_TEXT)) {
        const key = `${rel}\0${url}`;
        if (seen.has(key) || !changedByLeadingStrip(url)) continue;
        seen.add(key);
        found.push({ file: rel, url });
      }
    }
  };
  const blocks = path.join(root, ".deco", "blocks");
  if (fs.existsSync(blocks)) {
    const files = fs
      .readdirSync(blocks, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => path.join(d.parentPath, d.name))
      .sort();
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      add(file, stringsOf(parsed, []));
    }
  }
  for (const file of listSources(path.join(root, "src")))
    add(file, [fs.readFileSync(file, "utf8")]);
  return found;
}
