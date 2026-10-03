#!/usr/bin/env node
// The `deco` command (spec: internals › How the CLI ships). A small JavaScript
// file that loads the CLI's TypeScript sources: Bun runs them as they are;
// under Node, tsx's loader is registered first.
const entry = new URL("../src/v8/cli/main.ts", import.meta.url);

if (typeof globalThis.Bun !== "undefined") {
  await import(entry.href);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import(entry.href);
}
