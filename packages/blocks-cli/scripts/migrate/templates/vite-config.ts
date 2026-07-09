import type { MigrationContext } from "../types";

const PLATFORM_PACKAGE: Partial<Record<MigrationContext["platform"], string>> = {
  vtex: "@decocms/apps-vtex",
  shopify: "@decocms/apps-shopify",
  magento: "@decocms/apps-magento",
};

export function generateViteConfig(ctx: MigrationContext): string {
  const isVtex = ctx.platform === "vtex";
  const platformDep = PLATFORM_PACKAGE[ctx.platform];

  const vtexAccount = ctx.vtexAccount || ctx.siteName.replace(/-migrated$/, "").replace(/-storefront$/, "");

  const vtexProxy = isVtex ? `
    // VTEX API proxy for local development
    proxy: {
      "/api/": {
        target: VTEX_ORIGIN,
        changeOrigin: true,
        cookieDomainRewrite: { "*": "" },
      },
      "/checkout": {
        target: VTEX_ORIGIN,
        changeOrigin: true,
        cookieDomainRewrite: { "*": "" },
      },
    },` : "";

  const vtexConstants = isVtex ? `
const VTEX_ACCOUNT = "${vtexAccount}";
const VTEX_ENVIRONMENT = "vtexcommercestable";
const VTEX_DOMAIN = "com.br";
const VTEX_ORIGIN = \`https://\${VTEX_ACCOUNT}.\${VTEX_ENVIRONMENT}.\${VTEX_DOMAIN}\`;
` : "";

  return `import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { decoVitePlugin } from "@decocms/tanstack/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import path from "path";

const srcDir = path.resolve(__dirname, "src");
${vtexConstants}
export default defineConfig({
  server: {
    allowedHosts: [".decocdn.com"],${vtexProxy}
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({ server: { entry: "server" } }),
    react({
      babel: {
        plugins: [
          ["babel-plugin-react-compiler", { target: "19" }],
        ],
      },
    }),
    tailwindcss(),
    decoVitePlugin(),
  ],
  build: {
    sourcemap: "hidden",
    rollupOptions: {
      onLog(level, log, handler) {
        if (
          log.code === "PLUGIN_WARNING" &&
          log.plugin === "vite:reporter" &&
          log.message?.includes("dynamic import will not move module")
        ) {
          return;
        }
        handler(level, log);
      },
    },
  },
  define: {
    "process.env.DECO_SITE_NAME": JSON.stringify(
      process.env.DECO_SITE_NAME || "${ctx.siteName}"
    ),
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    dedupe: [
      "@decocms/blocks",
      "@decocms/blocks-admin",
      "@decocms/tanstack",
      "@decocms/apps-commerce",${platformDep ? `\n      "${platformDep}",` : ""}
      "@tanstack/react-start",
      "@tanstack/react-router",
      "@tanstack/react-start-server",
      "@tanstack/start-server-core",
      "@tanstack/start-client-core",
      "@tanstack/start-plugin-core",
      "@tanstack/start-storage-context",
      "react",
      "react-dom",
    ],
    alias: {
      "~": srcDir,
    },
  },
});
`;
}
