import { decoContent } from "@decocms/blocks/vite";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr", childEnvironments: ["rsc"] } }),
    tanstackStart({ rsc: { enabled: true } }),
    rsc(),
    react(),
    // vite dev: a block saved in the site editor shows in open pages.
    decoContent(),
  ],
  environments: {
    rsc: { build: { outDir: "dist/server/rsc" } },
  },
});
