/**
 * `@decocms/blocks/vite`: `decoContent()`, the Vite plugin that shows a saved
 * block in open pages during `vite dev`. Vite sites add it to
 * `vite.config.ts`; Next.js sites don't use it.
 *
 * `deco serve` (the site editor's local server) rewrites
 * `.deco/blocks.gen.ts` on every save. In `vite dev` the plugin makes that
 * module accept its own updates in the server environments: the new module
 * goes into the CMS already created for its `.deco` folder (`adoptContent`),
 * so the module that created the CMS (`src/cms.ts`) doesn't run again, and
 * only then does the server tell open pages to reload. Reloading on the file
 * change itself is too early: the page would render the previous save.
 *
 * The generated file on disk is unchanged; `vite build` doesn't use the
 * plugin. It needs Vite 6 or newer (the Environment API) and works with
 * `@cloudflare/vite-plugin` (whatever its worker environment is named) and
 * with plain SSR environments.
 */
import type { Plugin } from "vite";

/** The event the content module sends from a server environment once the CMS has its new content. */
export const CONTENT_UPDATED_EVENT = "decocms:content-updated";

/** How long the plugin waits for another update of the same save before reloading open pages. */
const RELOAD_DELAY_MS = 100;

/** The module the footer imports `adoptContent` from. */
const HOT_MODULE = "@decocms/blocks/vite/hot";

/** The content module `deco content` writes, wherever the `.deco` folder is. */
const CONTENT_MODULE = /(?:^|[\\/])\.deco[\\/]blocks\.gen\.ts$/;

/** Whether a module id (possibly with a query) is a site's `.deco/blocks.gen.ts`. */
export function isContentModule(id: string): boolean {
  const file = id.split("?", 1)[0] ?? id;
  if (/[\\/]node_modules[\\/]/.test(file)) return false;
  return CONTENT_MODULE.test(file);
}

/**
 * What the plugin appends to the content module in a server environment:
 * accept its own next version, hand it to the CMS, then announce it.
 */
export function contentModuleFooter(): string {
  return [
    "",
    "// Added by decoContent() (@decocms/blocks/vite) in vite dev only.",
    `import { adoptContent as __decoAdoptContent } from ${JSON.stringify(HOT_MODULE)};`,
    "if (import.meta.hot) {",
    "  import.meta.hot.accept((next) => {",
    "    if (next?.default) __decoAdoptContent(next.default);",
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
    transform(code, id, options) {
      if (!isContentModule(id)) return null;
      const consumer = this.environment?.config.consumer;
      const server = consumer === undefined ? options?.ssr === true : consumer === "server";
      if (!server) return null;
      // Appended, so no line moves and the incoming source map still holds.
      return { code: code + contentModuleFooter(), map: null };
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
