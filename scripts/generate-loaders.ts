#!/usr/bin/env tsx
// Drop-in shim for `tsx node_modules/@decocms/start/scripts/generate-loaders.ts`.
// Real implementation is bundled to dist/scripts/generate-loaders.cjs by tsup;
// the source lives in scripts/_impl/ (kept out of the published tarball).
import { createRequire } from "node:module";
createRequire(import.meta.url)("../dist/scripts/generate-loaders.cjs");
