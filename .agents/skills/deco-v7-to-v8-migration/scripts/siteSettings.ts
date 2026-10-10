/**
 * Site settings (spec: renames-and-migrations › Site settings): the next
 * major keeps site-wide settings in one saved block, `CMS`, of the built-in
 * type `cms-settings`. This step folds what it finds into
 * `.deco/blocks/CMS.json`:
 *
 * - the v7 Site block's (`Site` or `site`) `previewHosts` → `preview.hosts`,
 *   each entry trimmed and lowercased as v7 compared it (the field moves; the
 *   rest of the Site block stays). An entry that isn't a host pattern is left
 *   out and reported. On TanStack Start, v7 also allowed the site's
 *   `<site>.deco.site` and `<site>.deco-cx.workers.dev` (from `DECO_SITE_NAME`):
 *   they're added when the name is found, and reported when it isn't;
 * - a literal `collectorAddress` on v7's `OneDollarStats` component in
 *   `src/` → `analytics.collector`;
 * - a prerelease `Telemetry` / `Analytics` saved block (type `telemetry` /
 *   `analytics`) → its section, field for field, variants included; the old
 *   file is deleted.
 *
 * What's already in `CMS.json` is kept; nothing is written when there's
 * nothing to fold, and a second run changes nothing. Settings v7 read from
 * the hosting environment are listed in the report.
 */
import fs from "node:fs";
import path from "node:path";
import { formatHostPattern, LEGACY_ALIASES, parseHostPattern } from "@decocms/blocks/cli";
import { blockFileName, serializeBlock } from "@decocms/blocks/protocol/keys";
import type { Report } from "./report";
import { isPlainObject, type JsonObject, readContent } from "./walk";

const SETTINGS_BLOCK = "CMS";
const SETTINGS_TYPE = "cms-settings";
const SITE_BLOCKS = ["site", "Site"];
/** Prerelease well-known blocks, by name, and the built-in type each had. */
const PRERELEASE: { name: string; type: "telemetry" | "analytics" }[] = [
  { name: "Telemetry", type: "telemetry" },
  { name: "Analytics", type: "analytics" },
];
const SOURCE = /\.(tsx?|jsx?|mts|cts)$/;

type Section = "preview" | "telemetry" | "analytics";

function isMultivariate(type: unknown): boolean {
  return (
    type === "multivariate" ||
    (typeof type === "string" &&
      Object.hasOwn(LEGACY_ALIASES, type) &&
      LEGACY_ALIASES[type] === "multivariate")
  );
}

/**
 * A prerelease `telemetry`/`analytics` block as its section: its fields
 * without `__resolveType`. A `multivariate` stays one, with each variant's
 * value turned into a section the same way; anything else (a reference to
 * another saved block) is kept as is.
 */
function asSection(node: unknown, type: string): unknown {
  if (!isPlainObject(node)) return node;
  if (node.__resolveType === type) {
    const { __resolveType: _, ...fields } = node;
    return fields;
  }
  if (isMultivariate(node.__resolveType) && Array.isArray(node.variants)) {
    return {
      ...node,
      variants: node.variants.map((variant) => {
        if (!isPlainObject(variant)) return variant;
        const value = variant.value;
        if (isPlainObject(value) && value.__resolveType === "lazy") {
          return { ...variant, value: { ...value, value: asSection(value.value, type) } };
        }
        return { ...variant, value: asSection(value, type) };
      }),
    };
  }
  return node;
}

/** Whether a prerelease block is (or picks between) the given built-in. */
function isPrereleaseBlock(node: unknown, type: string): boolean {
  if (!isPlainObject(node)) return false;
  if (node.__resolveType === type) return true;
  if (!isMultivariate(node.__resolveType) || !Array.isArray(node.variants)) return false;
  return node.variants.some((variant) => {
    if (!isPlainObject(variant)) return false;
    const value = variant.value;
    const inner = isPlainObject(value) && value.__resolveType === "lazy" ? value.value : value;
    return isPlainObject(inner) && inner.__resolveType === type;
  });
}

/**
 * Whether v7 ran on `@decocms/tanstack`, whose worker entry added the site's
 * deco-hosted domains to the preview hosts. v7's Next.js binding never did.
 */
function isTanStackSite(root: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return ["dependencies", "devDependencies"].some(
      (field) => isPlainObject(pkg[field]) && Object.hasOwn(pkg[field], "@decocms/tanstack"),
    );
  } catch {
    return false;
  }
}

/**
 * The `DECO_SITE_NAME` v7's TanStack worker read: from the Workers vars in
 * `wrangler.*` first, else from `.env`/`.dev.vars` and the Vite config's
 * fallback. `undefined` when there's none, or several that disagree.
 */
function v7SiteName(root: string): { name?: string; candidates: string[] } {
  const read = (file: string) => {
    const full = path.join(root, file);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  };
  const NAME = /^[a-z0-9][a-z0-9-]*$/;
  const collect = (files: string[], pattern: RegExp) => {
    const found = new Set<string>();
    for (const file of files) {
      for (const match of read(file).matchAll(pattern)) {
        const name = match[1]?.trim().toLowerCase();
        if (name && NAME.test(name)) found.add(name);
      }
    }
    return [...found];
  };
  const fromWrangler = collect(
    ["wrangler.jsonc", "wrangler.json", "wrangler.toml"],
    /["']?DECO_SITE_NAME["']?\s*[:=]\s*["']([^"']+)["']/g,
  );
  const candidates =
    fromWrangler.length > 0
      ? fromWrangler
      : [
          ...new Set([
            ...collect([".env", ".dev.vars"], /^\s*DECO_SITE_NAME\s*=\s*["']?([^"'\s#]+)/gm),
            ...collect(
              ["vite.config.ts", "vite.config.js", "vite.config.mts"],
              /DECO_SITE_NAME\s*\|\|\s*["']([^"']+)["']/g,
            ),
          ]),
        ];
  return { name: candidates.length === 1 ? candidates[0] : undefined, candidates };
}

/** The hosts v7's TanStack worker always allowed for a named site. */
function decoHostedHosts(site: string): string[] {
  return [`${site}.deco.site`, `${site}.deco-cx.workers.dev`];
}

function listSources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && SOURCE.test(d.name) && !d.name.endsWith(".d.ts"))
    .map((d) => path.join(d.parentPath, d.name))
    .filter((f) => !f.split(path.sep).includes("node_modules"));
}

/** Literal `collectorAddress` values on `<OneDollarStats …>` elements in `src/`. */
function oneDollarCollectors(root: string): { values: Set<string>; dynamic: string[] } {
  const values = new Set<string>();
  const dynamic: string[] = [];
  for (const file of listSources(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("OneDollarStats")) continue;
    for (const element of text.matchAll(/<OneDollarStats\b([^>]*)\/?>/g)) {
      const attributes = element[1];
      if (!/\bcollectorAddress\s*=/.test(attributes)) continue;
      const literal =
        /\bcollectorAddress\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\}|\{\s*`([^`$]*)`\s*\})/.exec(
          attributes,
        );
      const value = literal?.slice(1).find((v) => v !== undefined);
      if (value) values.add(value);
      else dynamic.push(path.relative(root, file).split(path.sep).join("/"));
    }
  }
  return { values, dynamic };
}

/**
 * Sets `value` at `section` (and `field`, when given) of `target` unless
 * something is already there. Returns whether it changed anything.
 */
function fold(target: JsonObject, section: Section, value: unknown, field?: string): boolean {
  if (field === undefined) {
    if (target[section] === undefined) {
      target[section] = value;
      return true;
    }
    const existing = target[section];
    // Both plain sections: fold field by field; a section with variants is kept as it is.
    if (!isPlainObject(existing) || "__resolveType" in existing) return false;
    if (!isPlainObject(value) || "__resolveType" in value) return false;
    let changed = false;
    for (const [key, v] of Object.entries(value))
      changed = fold(target, section, v, key) || changed;
    return changed;
  }
  const existing = target[section];
  if (existing === undefined) {
    target[section] = { [field]: value };
    return true;
  }
  if (!isPlainObject(existing) || "__resolveType" in existing) return false;
  if (existing[field] !== undefined) return false;
  existing[field] = value;
  return true;
}

export function foldSiteSettings(root: string, report: Report): void {
  const blocksDir = path.join(root, ".deco", "blocks");
  const { blocks, files } = readContent(root);

  const current = blocks[SETTINGS_BLOCK];
  if (current !== undefined && current.__resolveType !== SETTINGS_TYPE) {
    report.manual.push({
      step: "settings",
      subject: `.deco/blocks/${files[SETTINGS_BLOCK]}`,
      message: `"${SETTINGS_BLOCK}" is the name of the CMS settings block (type "${SETTINGS_TYPE}"); rename this "${String(current.__resolveType)}" block, then run the migration again to fold your settings (/next/renames-and-migrations#site-settings)`,
    });
    return;
  }
  const settings: JsonObject = current
    ? (JSON.parse(JSON.stringify(current)) as JsonObject)
    : { __resolveType: SETTINGS_TYPE };
  const done: string[] = [];
  const remove: string[] = [];
  /** Saved blocks to write back, without a field that moved. */
  const rewrite = new Map<string, JsonObject>();

  // The v7 Site block's preview hosts, plus the deco-hosted ones v7's TanStack worker added.
  const tanstack = isTanStackSite(root);
  const siteName = tanstack ? v7SiteName(root) : { candidates: [] };
  let previewHosts: string[] | undefined;
  for (const name of SITE_BLOCKS) {
    const site = blocks[name];
    if (!site || !Array.isArray(site.previewHosts)) continue;
    previewHosts = [];
    for (const raw of site.previewHosts) {
      // v7 trimmed and lowercased each entry and compared it to the request's host[:port].
      const entry = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
      const pattern = typeof entry === "string" ? parseHostPattern(entry) : null;
      if (pattern === null || pattern.kind === "any" || pattern.kind === "wildcard") {
        report.manual.push({
          step: "settings",
          subject: `.deco/blocks/${files[name]}`,
          message: `previewHosts entry ${JSON.stringify(raw)} isn't a host v7 could match; it was left out of CMS.json's preview.hosts, so add the host you meant by hand (/next/api-reference#host-patterns)`,
        });
        continue;
      }
      previewHosts.push(formatHostPattern(pattern));
    }
    if (tanstack && siteName.name) previewHosts.push(...decoHostedHosts(siteName.name));
    previewHosts = [...new Set(previewHosts)];
    if (tanstack && !siteName.name) {
      report.manual.push({
        step: "settings",
        subject: "preview hosts",
        message: `v7 also allowed previews on <site>.deco.site and <site>.deco-cx.workers.dev for the site named by DECO_SITE_NAME${siteName.candidates.length > 1 ? ` (found several: ${siteName.candidates.join(", ")})` : ""}; add the ones you use to CMS.json's preview.hosts (/next/releases-and-drafts#allow-previews-per-host)`,
      });
    }
    const folded = fold(settings, "preview", previewHosts, "hosts");
    const preview = settings.preview;
    const hosts = isPlainObject(preview) ? preview.hosts : undefined;
    // The field moves when CMS.json now holds those hosts; one that disagrees is left for a person.
    if (folded || JSON.stringify(hosts) === JSON.stringify(previewHosts)) {
      const { previewHosts: _, ...rest } = site;
      rewrite.set(files[name], rest);
      done.push(`preview.hosts from the ${name} block's previewHosts`);
    } else {
      report.manual.push({
        step: "settings",
        subject: `.deco/blocks/${files[name]}`,
        message:
          "its previewHosts differ from preview.hosts in CMS.json; keep the right list in CMS.json and delete previewHosts",
      });
    }
    break;
  }

  // No previewHosts at all: v7's TanStack worker still allowed previews only on the site's
  // deco-hosted hosts, while v8 allows every host without a list. Keep v7's list when the name is known.
  if (
    previewHosts === undefined &&
    settings.preview === undefined &&
    tanstack &&
    siteName.name &&
    fold(settings, "preview", decoHostedHosts(siteName.name), "hosts")
  ) {
    previewHosts = decoHostedHosts(siteName.name);
    done.push(
      `preview.hosts: ${previewHosts.join(", ")} (v7 allowed previews only there, from DECO_SITE_NAME; add your dev and staging hosts)`,
    );
  }

  // A literal collectorAddress on OneDollarStats.
  const collectors = oneDollarCollectors(root);
  if (collectors.values.size === 1) {
    const [collector] = collectors.values;
    if (fold(settings, "analytics", collector, "collector")) {
      done.push("analytics.collector from OneDollarStats' collectorAddress");
    }
  } else if (collectors.values.size > 1) {
    report.manual.push({
      step: "settings",
      subject: "OneDollarStats collectorAddress",
      message: `several collectors (${[...collectors.values].join(", ")}): put the one to keep in CMS.json's analytics.collector (/next/analytics)`,
    });
  }
  for (const file of collectors.dynamic) {
    report.manual.push({
      step: "settings",
      subject: file,
      message:
        "OneDollarStats' collectorAddress isn't a literal: put its value in CMS.json's analytics.collector (/next/analytics)",
    });
  }

  // Prerelease Telemetry.json / Analytics.json.
  for (const { name, type } of PRERELEASE) {
    const block = blocks[name];
    if (!isPrereleaseBlock(block, type)) continue;
    const section = asSection(block, type);
    const changed = fold(settings, type, section);
    if (!changed && settings[type] !== undefined && !isSubset(section, settings[type])) {
      report.manual.push({
        step: "settings",
        subject: `.deco/blocks/${files[name]}`,
        message: `CMS.json already has a ${type} section that differs; merge this block into it by hand, then delete it`,
      });
      continue;
    }
    remove.push(files[name]);
    done.push(`the ${type} section from ${files[name]} (deleted)`);
  }

  // Leftover blocks of the folded built-ins fail deco check.
  for (const [name, block] of Object.entries(blocks)) {
    if (remove.includes(files[name])) continue;
    const type = block.__resolveType;
    if (type === "telemetry" || type === "analytics") {
      report.manual.push({
        step: "settings",
        subject: `.deco/blocks/${files[name]}`,
        message: `the "${type}" built-in is gone: fold this block into the ${type} section of CMS.json (/next/renames-and-migrations#site-settings)`,
      });
    }
  }

  if (done.length > 0) {
    fs.mkdirSync(blocksDir, { recursive: true });
    const file = files[SETTINGS_BLOCK] ?? blockFileName(SETTINGS_BLOCK);
    const next = serializeBlock(settings);
    const full = path.join(blocksDir, file);
    if (!fs.existsSync(full) || fs.readFileSync(full, "utf8") !== next) {
      fs.writeFileSync(full, next);
    }
    for (const [old, block] of rewrite)
      fs.writeFileSync(path.join(blocksDir, old), serializeBlock(block));
    for (const old of remove) fs.rmSync(path.join(blocksDir, old), { force: true });
    report.done.push({
      step: "settings",
      subject: `.deco/blocks/${file}`,
      message: `folded ${done.join("; ")}`,
    });
  }

  // Settings v7 read from the hosting environment never reach the repository.
  report.manual.push(
    {
      step: "settings",
      subject: "DECO_ALLOWED_PREVIEW_HOSTS",
      message:
        "if your hosting sets it, put its hosts in CMS.json's preview.hosts, or in createCMS({ preview: { hosts } }) to make them the most content may allow; its none is an empty list (/next/releases-and-drafts#allow-previews-per-host)",
    },
    {
      step: "settings",
      subject: "DECO_OTEL_* sampling",
      message:
        "if your hosting sets sampling variables, move them to the telemetry section's errorSampleRate and traceSampleRate, within the limits in code (/next/telemetry#sampling)",
    },
    {
      step: "settings",
      subject: "DECO_ANALYTICS_ENABLED, ONEDOLLAR_ENABLED, ONEDOLLAR_COLLECTOR",
      message:
        "if your hosting sets them, the enabled ones become the analytics section's enabled and ONEDOLLAR_COLLECTOR its collector (/next/analytics)",
    },
  );
  if (previewHosts === undefined && settings.preview === undefined && current === undefined) {
    const v7Hosts = siteName.name
      ? `only on ${decoHostedHosts(siteName.name).join(" and ")} (from DECO_SITE_NAME)`
      : tanstack
        ? "only on <site>.deco.site and <site>.deco-cx.workers.dev for the site named by DECO_SITE_NAME, or nowhere without one"
        : "nowhere";
    report.manual.push({
      step: "settings",
      subject: "preview hosts",
      message: `with no previewHosts, v7 allowed previews ${v7Hosts}; the next major allows every host unless preview.hosts lists some, so add that list to CMS.json if you relied on it (/next/releases-and-drafts#allow-previews-per-host)`,
    });
  }
}

/** Whether every field of `part` is already in `whole` with the same value. */
function isSubset(part: unknown, whole: unknown): boolean {
  if (!isPlainObject(part) || !isPlainObject(whole)) {
    return JSON.stringify(part) === JSON.stringify(whole);
  }
  return Object.entries(part).every(([key, value]) => isSubset(value, whole[key]));
}
