#!/usr/bin/env node
// The `deco` command (spec: internals › How the CLI ships). It runs the CLI's
// compiled JavaScript in dist/ (one .js per source file, emitted by `tsc`), so
// plain Node, Bun and npx all run it with no TypeScript loader. In a checkout,
// `bun run build` (or `bun install`, which builds the workspace) writes dist/.
await import(new URL("../dist/v8/cli/main.js", import.meta.url).href);
