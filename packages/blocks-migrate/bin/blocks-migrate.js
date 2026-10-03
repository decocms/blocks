#!/usr/bin/env node
// The `blocks-migrate` command. Loads the TypeScript sources: Bun runs them
// as they are; under Node, tsx's loader is registered first (the same way
// `deco` ships in @decocms/blocks).
const entry = new URL("../src/main.ts", import.meta.url);

if (typeof globalThis.Bun !== "undefined") {
  await import(entry.href);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import(entry.href);
}
