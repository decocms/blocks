/**
 * `@decocms/blocks/vite`: `decoContent()`, the Vite plugin that shows a saved
 * block in open pages during `vite dev`. Vite sites add it to
 * `vite.config.ts`; Next.js sites don't use it.
 *
 * `deco serve` (the site editor's local server) rewrites
 * `.deco/blocks.gen.ts` on every save. In `vite dev`, in the server
 * environments, the plugin makes each module that imports it (usually
 * `src/cms.ts`) accept that import's updates: the new content goes into the
 * CMS already created for its `.deco` folder (`adoptContent`), and only then
 * does the server tell open pages to reload. The importer is the update's
 * boundary, so neither it nor anything that imports it is invalidated or runs
 * again: TanStack Start re-imports its server entry on every request, and a
 * content module that accepted itself still left every module above it stale,
 * so `src/cms.ts` re-ran on every save. Reloading on the file change itself is
 * too early: the page would render the previous save.
 *
 * A module that already accepts the content module's updates itself (the
 * template code sites carried before this plugin) is left as it is.
 *
 * The files on disk are unchanged; `vite build` doesn't use the plugin. It
 * needs Vite 6 or newer (the Environment API) and works with
 * `@cloudflare/vite-plugin` (whatever its worker environment is named) and
 * with plain SSR environments.
 */
import type { Plugin } from "vite";

/** The event an importer of the content module sends from a server environment once the CMS has its new content. */
export const CONTENT_UPDATED_EVENT = "decocms:content-updated";

/** How long the plugin waits for another update of the same save before reloading open pages. */
const RELOAD_DELAY_MS = 100;

/** The module the footer imports `adoptContent` from. */
const HOT_MODULE = "@decocms/blocks/vite/hot";

/** The content module `deco content` writes, wherever the `.deco` folder is. */
const CONTENT_MODULE = /(?:^|[\\/])\.deco[\\/]blocks\.gen\.ts$/;

/** Source files whose imports the plugin reads. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** Static imports and re-exports: `import x from "s"`, `import "s"`, `export { x } from "s"`. */
const STATIC_IMPORT =
  /(?:^|[^\w$.])(?:import|export)(?:\s+type)?\s*(?:[\w$*{}\s,]*?\s*from\s*)?(["'])([^"'\r\n]+)\1/g;

/** `….accept("s", …)` or `….accept(["s", …], …)`: a module accepting a dependency's updates. */
const ACCEPT_CALL = /\.accept\s*\(\s*(\[[^\]]*\]|(["'`])[^"'`\r\n]+\2)/g;

/** Specifiers that never name a file of the site. */
const EXTERNAL = /^(?:node:|virtual:|\0|data:|https?:|cloudflare:)/;

/** Whether a module id (possibly with a query) is a site's `.deco/blocks.gen.ts`. */
export function isContentModule(id: string): boolean {
  const file = id.split("?", 1)[0] ?? id;
  if (/[\\/]node_modules[\\/]/.test(file)) return false;
  return CONTENT_MODULE.test(file);
}

/** The specifiers of a module's static imports and re-exports, in order, without duplicates. */
export function staticImports(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(STATIC_IMPORT)) found.add(match[2] as string);
  return [...found];
}

/** The dependency specifiers a module passes to `import.meta.hot.accept`. */
export function acceptedSpecifiers(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(ACCEPT_CALL)) {
    for (const literal of (match[1] as string).matchAll(/(["'`])([^"'`\r\n]+)\1/g)) {
      found.add(literal[2] as string);
    }
  }
  return [...found];
}

/**
 * What the plugin appends to a module that imports the content module (as
 * `specifier`) in a server environment: accept that import's next version,
 * hand it to the CMS, then announce it. The same code sites used to write in
 * `src/cms.ts` by hand.
 */
export function importerFooter(specifier: string): string {
  return [
    "",
    "// Added by decoContent() (@decocms/blocks/vite) in vite dev only.",
    `import { adoptContent as __decoAdoptContent } from ${JSON.stringify(HOT_MODULE)};`,
    "if (import.meta.hot) {",
    `  import.meta.hot.accept(${JSON.stringify(specifier)}, (next) => {`,
    "    if (next) __decoAdoptContent(next.default);",
    `    import.meta.hot?.send(${JSON.stringify(CONTENT_UPDATED_EVENT)});`,
    "  });",
    "}",
    "",
  ].join("\n");
}

/**
 * The Vite plugin: in `vite dev`, open pages show a saved block once the
 * server has it. Add it to `plugins` in `vite.config.ts`:
 *
 * ```ts
 * import { decoContent } from "@decocms/blocks/vite";
 * export default defineConfig({ plugins: [decoContent(), ...] });
 * ```
 */
export function decoContent(): Plugin {
  return {
    name: "decocms:content",
    apply: "serve",
    configEnvironment(name, config) {
      // The footer's import appears only after this transform, so the dependency
      // scan can't see it: pre-bundle it up front in the server environments.
      // Discovered on the first request instead, the worker re-optimizes its
      // dependencies and reloads the whole program once.
      if (name === "client" || config.consumer === "client") return;
      return { optimizeDeps: { include: [HOT_MODULE] } };
    },
    async transform(code, id, options) {
      const file = id.split("?", 1)[0] ?? id;
      if (id.startsWith("\0") || !SOURCE_FILE.test(file) || /[\\/]node_modules[\\/]/.test(file)) {
        return null;
      }
      if (isContentModule(id)) return null;
      const consumer = this.environment?.config.consumer;
      const server = consumer === undefined ? options?.ssr === true : consumer === "server";
      if (!server) return null;

      const imports = staticImports(code).filter((specifier) => !EXTERNAL.test(specifier));
      if (imports.length === 0) return null;
      const isContent = async (specifier: string) => {
        const resolved = await this.resolve(specifier, id);
        return resolved !== null && !resolved.external && isContentModule(resolved.id);
      };
      let content: string | undefined;
      for (const specifier of imports) {
        if (await isContent(specifier)) {
          content = specifier;
          break;
        }
      }
      if (content === undefined) return null;
      // A site that still accepts the content module's updates by hand keeps its own code.
      for (const specifier of acceptedSpecifiers(code)) {
        if (await isContent(specifier)) return null;
      }
      // Appended, so no line moves and the incoming source map still holds.
      return { code: code + importerFooter(content), map: null };
    },
    configureServer(server) {
      // A save writes the block's JSON file and then the content module, and
      // each one swaps the module: open pages reload once, after the last.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reload = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const client = server.environments?.client?.hot ?? server.hot;
          client.send({ type: "full-reload" });
        }, RELOAD_DELAY_MS);
      };
      const environments = Object.values(server.environments ?? {}).filter(
        (environment) => environment.config.consumer === "server",
      );
      for (const environment of environments) {
        environment.hot.on(CONTENT_UPDATED_EVENT, reload);
      }
    },
  };
}
