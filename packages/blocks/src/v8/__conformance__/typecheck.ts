/**
 * Test-only: type-checks doc snippets as an app would, in memory, so a snippet
 * that doesn't compile fails a test instead of the package's own `tsc` run.
 *
 * `@decocms/blocks` and its documented subpaths resolve to this package's
 * sources; `react` resolves from the workspace's `node_modules`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../..");

/** Type-checks `files` (paths relative to a virtual app root) and returns the error messages. */
export function typecheck(files: Record<string, string>): string[] {
  // The virtual app lives next to this file, so module resolution finds the workspace's node_modules.
  const root = path.join(here, "__virtual_app__");
  const virtual = new Map<string, string>();
  for (const [name, text] of Object.entries(files)) virtual.set(path.join(root, name), text);

  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
    baseUrl: root,
    paths: {
      "@decocms/blocks": [path.join(src, "index.ts")],
      "@decocms/blocks/fetch": [path.join(src, "v8/fetch.ts")],
      "@decocms/blocks/analytics": [path.join(src, "v8/analytics.ts")],
      "@decocms/blocks/secrets": [path.join(src, "v8/secrets.ts")],
    },
  };
  const host = ts.createCompilerHost(options, true);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (file) => virtual.has(path.resolve(file)) || fileExists.call(host, file);
  const { directoryExists } = host;
  host.directoryExists = (dir) => {
    const resolved = path.resolve(dir);
    for (const file of virtual.keys()) if (file.startsWith(resolved + path.sep)) return true;
    return directoryExists ? directoryExists.call(host, dir) : ts.sys.directoryExists(dir);
  };
  host.readFile = (file) => virtual.get(path.resolve(file)) ?? readFile.call(host, file);
  host.getSourceFile = (file, language, onError, shouldCreate) => {
    const text = virtual.get(path.resolve(file));
    if (text !== undefined) return ts.createSourceFile(file, text, language, true);
    return getSourceFile.call(host, file, language, onError, shouldCreate);
  };
  const program = ts.createProgram([...virtual.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file === undefined || virtual.has(path.resolve(d.file.fileName)))
    .map((d) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (!d.file || d.start === undefined) return message;
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      return `${path.relative(root, d.file.fileName)}:${line + 1}: ${message}`;
    });
}
