import { cloudflare } from "@cloudflare/vite-plugin";
import { decoTanstack } from "@decocms/tanstack/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    react(),
    // decoContent(), __BUILD_HASH__ (the CI's sha, else git's) and one copy of React and TanStack.
    decoTanstack({ buildHash: process.env.WORKERS_CI_COMMIT_SHA }),
  ],
});
