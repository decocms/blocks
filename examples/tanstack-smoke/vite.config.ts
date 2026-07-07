import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error — @decocms/tanstack/vite is a plain .js file with no
// shipped .d.ts (pre-existing, predates the monorepo split; see task-7-report.md).
import { decoVitePlugin } from "@decocms/tanstack/vite";

export default defineConfig({
  plugins: [tanstackStart(), react(), decoVitePlugin()],
  resolve: {
    dedupe: ["react", "react-dom", "@decocms/blocks", "@decocms/admin", "@decocms/tanstack"],
  },
});
