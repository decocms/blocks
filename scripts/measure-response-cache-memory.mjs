// Node 22+. Pass an installed Miniflare module path if it is not available locally:
// node scripts/measure-response-cache-memory.mjs /path/to/miniflare/dist/src/index.js
// Optional second argument: responseCache.ts from another checkout for comparison.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(new URL("../packages/blocks/package.json", import.meta.url));
const { build } = require("esbuild");
const { Miniflare } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : "miniflare");
const sourcePath = process.argv[3] ? resolve(process.argv[3]) : fileURLToPath(new URL("../packages/blocks/src/sdk/responseCache.ts", import.meta.url));
let source = await readFile(sourcePath, "utf8");
assert.match(source, /const body = .*;/, "Cannot locate the cache decode boundary");
// Pause immediately before/after the real decoder; query workerd's heap via CDP.
source = source.replace(/const body = .*;/, "debugger; $& debugger;");
source += `
export default { async fetch() {
  const raw = JSON.stringify({status: 200, statusText: 'OK', headers: [], body: btoa('a'.repeat(4 * 1024 * 1024))});
  return createResponseCache({get: async () => raw} as any, 'measurement').match(new Request('https://test/page'));
}};
`;
const built = await build({ stdin: { contents: source, loader: "ts", resolveDir: dirname(sourcePath) }, bundle: true, write: false, format: "esm", target: "es2022" });
const mf = new Miniflare({ modules: true, script: built.outputFiles[0].text, inspectorPort: 0 });
let ws;
try {
  const inspector = String(await mf.getInspectorURL()).replace("ws:", "http:");
  const targets = await (await fetch(new URL("/json/list", inspector))).json();
  ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  const samples = [];
  const command = (method) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => reject(new Error(`Inspector timeout: ${method}`)), 20_000);
    pending.set(key, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: key, method }));
  });
  ws.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      message.error ? entry.reject(message.error) : entry.resolve(message.result);
    } else if (message.method === "Debugger.paused") {
      samples.push(await command("Runtime.getHeapUsage"));
      await command("Debugger.resume");
    }
  });
  await command("Debugger.enable");
  const response = await mf.dispatchFetch("https://test/page");
  assert.equal((await response.arrayBuffer()).byteLength, 4 * 1024 * 1024);
  assert.equal(samples.length, 2);
  const heapCapacityGrowth = samples[1].totalSize - samples[0].totalSize;
  console.log(JSON.stringify({ bodyBytes: 4 * 1024 * 1024, heapCapacityGrowth, samples }));
  // A fresh isolated Worker avoids app/GC noise. Allow 4x body size for heap growth.
  // The iterable-array implementation grows the heap by roughly 60 MiB here.
  assert(heapCapacityGrowth <= 16 * 1024 * 1024, "Cache decoding allocated excessive temporary heap");
} finally {
  ws?.close();
  await mf.dispose();
}
