/**
 * Vendoring (spec: renames-and-migrations › Loaders, actions and invoke). In
 * the next major the apps ship no loaders or actions, so the ones a site's
 * content uses are copied into the site, from the v7 app package it has
 * installed, with every module they import from that same package.
 *
 * A v7 type name `<app>/<path>` lives in `@decocms/apps-<app>/src/<path>`
 * (7.x) or `@decocms/apps/<app>/<path>` (6.x). Either way it is copied to
 * `src/vendor/<app>/<path>`, so relative imports inside the copy keep
 * working, and imports of the package by name are rewritten to relative ones.
 * Imports of other packages stay as they are; the import report lists them.
 */
import fs from "node:fs";
import path from "node:path";
import type { Report } from "./report";

const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const VENDOR_DIR = path.join("src", "vendor");

/** `.tsx?` is optional in v7 type names (`shopify/loaders/ProductList` and `…/ProductList.ts`). */
function withExtensions(file: string): string[] {
  return /\.(tsx?|jsx?)$/.test(file)
    ? [file]
    : [
        ...SOURCE_EXTENSIONS.map((e) => file + e),
        ...SOURCE_EXTENSIONS.map((e) => path.join(file, `index${e}`)),
      ];
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The first candidate that is a file. */
export function firstFile(candidates: string[]): string | undefined {
  return candidates.find(isFile);
}

interface PackageRef {
  /** The package folder in node_modules. */
  dir: string;
  /** `exports` of its package.json. */
  exports: Record<string, string>;
}

function readPackage(root: string, name: string): PackageRef | undefined {
  const dir = path.join(root, "node_modules", name);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const exports: Record<string, string> = {};
    for (const [key, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target === "string") exports[key] = target;
    }
    if (!exports["."] && typeof manifest.main === "string") exports["."] = manifest.main;
    return { dir: fs.realpathSync(dir), exports };
  } catch {
    return undefined;
  }
}

/** A subpath through a package's `exports` (exact keys and one-`*` patterns). */
function matchExports(pkg: PackageRef, subpath: string): string | undefined {
  const exact = pkg.exports[subpath];
  if (exact) return firstFile([path.join(pkg.dir, exact)]);
  for (const [key, target] of Object.entries(pkg.exports)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= key.length - 1
    ) {
      const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
      const file = firstFile([path.join(pkg.dir, target.replace("*", middle))]);
      if (file) return file;
    }
  }
  return undefined;
}

function splitSpecifier(specifier: string): { name: string; subpath: string } | undefined {
  const parts = specifier.split("/");
  if (specifier.startsWith("@") ? parts.length < 2 : parts.length < 1) return undefined;
  const count = specifier.startsWith("@") ? 2 : 1;
  const rest = parts.slice(count).join("/");
  return { name: parts.slice(0, count).join("/"), subpath: rest ? `./${rest}` : "." };
}

/** The file a bare specifier names in the site's node_modules, through the package's `exports`. */
export function resolvePackageFile(root: string, specifier: string): string | undefined {
  const parts = splitSpecifier(specifier);
  if (!parts) return undefined;
  const pkg = readPackage(root, parts.name);
  return pkg ? matchExports(pkg, parts.subpath) : undefined;
}

/** Where one app's sources sit, and where its copies go. */
interface AppSource {
  /** The package's source root: copies keep their path relative to it. */
  base: string;
  /** The folder a v7 type name's `<path>` starts in. */
  dir: string;
  /** The package name; its own imports by name are rewritten to the copies. */
  packageName: string;
  /** Where the copies go: `src/vendor/<app>` (7.x) or `src/vendor` (6.x, a folder per app). */
  dest: string;
}

function appSources(root: string, app: string): AppSource[] {
  const sources: AppSource[] = [];
  const split = readPackage(root, `@decocms/apps-${app}`); // 7.x: one package per app
  if (split) {
    const base = path.join(split.dir, "src");
    sources.push({
      base,
      dir: base,
      packageName: `@decocms/apps-${app}`,
      dest: path.join(root, VENDOR_DIR, app),
    });
  }
  const single = readPackage(root, "@decocms/apps"); // 6.x: one package, a folder per app
  if (single) {
    sources.push({
      base: single.dir,
      dir: path.join(single.dir, app),
      packageName: "@decocms/apps",
      dest: path.join(root, VENDOR_DIR),
    });
  }
  return sources;
}

interface AppModule {
  file: string;
  app: AppSource;
}

/** The installed v7 source of a type name like `shopify/loaders/ProductList.ts`, if any. */
export function locateAppModule(root: string, type: string): AppModule | undefined {
  const [app, ...rest] = type.split("/");
  if (!app || rest.length === 0) return undefined;
  for (const source of appSources(root, app)) {
    const file = firstFile(withExtensions(path.join(source.dir, ...rest)));
    // A type name is content, which editors control: never leave the package.
    if (file && isInside(source.base, file)) return { file, app: source };
  }
  return undefined;
}

const IMPORT_SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bexport\s+\*\s+from\s*)(["'])([^"']+)\2/g;

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** An import specifier from one file to another, without extension or `/index`. */
export function relativeSpecifier(fromFile: string, toFile: string): string {
  let rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/");
  rel = rel.replace(/(\/index)?\.tsx?$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Copy `entry` and the modules of its package it imports into the site, and
 * return the copy of `entry`. `copies` maps each installed source to its copy
 * and is shared across calls, so a module is copied once. A copy that exists
 * is kept, so a second run never overwrites edits.
 */
export function vendorModule(
  root: string,
  entry: AppModule,
  copies: Map<string, string>,
  report: Report,
): string {
  const { app } = entry;
  const destOf = (source: string) => path.join(app.dest, path.relative(app.base, source));
  const queue = [entry.file];

  while (queue.length > 0) {
    const source = queue.shift()!;
    if (copies.has(source)) continue;
    const dest = destOf(source);
    copies.set(source, dest);
    let text = fs.readFileSync(source, "utf8");
    text = text.replace(
      IMPORT_SPECIFIER,
      (match, lead: string, quote: string, specifier: string) => {
        let target: string | undefined;
        if (specifier.startsWith(".")) {
          target = firstFile(
            withExtensions(path.resolve(path.dirname(source), specifier.replace(/\.js$/, ""))),
          );
        } else if (specifier === app.packageName || specifier.startsWith(`${app.packageName}/`)) {
          target = resolvePackageFile(root, specifier);
        } else {
          return match;
        }
        if (!target) {
          const asset = specifier.startsWith(".")
            ? path.resolve(path.dirname(source), specifier)
            : undefined;
          if (asset && isInside(app.base, asset) && isFile(asset)) {
            // A JSON or other non-TS file: copied as it is, same relative path.
            const assetDest = destOf(asset);
            if (!fs.existsSync(assetDest)) {
              fs.mkdirSync(path.dirname(assetDest), { recursive: true });
              fs.copyFileSync(asset, assetDest);
            }
          } else {
            report.manual.push({
              step: "vendor",
              subject: path.relative(root, dest),
              message: `imports ${specifier}, which doesn't resolve to a file; fix the import`,
            });
          }
          return match;
        }
        if (!isInside(app.base, target)) {
          report.manual.push({
            step: "vendor",
            subject: path.relative(root, dest),
            message: `imports ${specifier}, outside ${app.packageName}; fix the import`,
          });
          return match;
        }
        queue.push(target);
        return specifier.startsWith(".")
          ? match
          : `${lead}${quote}${relativeSpecifier(dest, destOf(target))}${quote}`;
      },
    );
    if (!fs.existsSync(dest)) {
      const origin = path.relative(app.base, source).split(path.sep).join("/");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(
        dest,
        `// Vendored from ${app.packageName} (${origin}) by the deco-v7-to-v8-migration skill. It's your code now.\n${text}`,
      );
    }
  }
  return destOf(entry.file);
}
