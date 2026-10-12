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
  ],
  environments: {
    rsc: { build: { outDir: "dist/server/rsc" } },
  },
});
