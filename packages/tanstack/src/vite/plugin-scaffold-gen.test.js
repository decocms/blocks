import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execCalls = [];
const execFileSyncCalls = [];

vi.mock("node:child_process", () => {
  const exec = (cmd, _opts, cb) => {
    execCalls.push(cmd);
    cb(null, "", "");
  };
  const execFileSync = (cmd, args) => {
    execFileSyncCalls.push([cmd, args]);
    return "";
  };
  return { exec, execFileSync, default: { exec, execFileSync } };
});

/**
 * Regression guard for #371: `vite dev` never re-ran the sections/loaders/
 * invoke generators, only `npm run build` did (via the full `generate`
 * orchestrator) — so editing a section/loader's TS interface left the
 * `.gen` files silently stale until a manual `generate` run. This test
 * exercises `configureServer`'s scaffold-gen hook against a real
 * (empty) tmp dir + a real EventEmitter as `server.watcher`, with
 * `node:child_process` mocked so no real subprocess is spawned.
 */
describe("decoVitePlugin — sections/loaders/invoke dev regeneration (#371)", () => {
  let tmp;
  let cwdSpy;
  let plugin;

  beforeEach(async () => {
    vi.resetModules();
    execCalls.length = 0;
    execFileSyncCalls.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-scaffold-gen-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    vi.useFakeTimers();
    ({ decoVitePlugin: plugin } = await import("./plugin.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
    cwdSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeServer() {
    return {
      watcher: new EventEmitter(),
      config: { define: {} },
      environments: undefined,
      httpServer: { once: () => {} },
    };
  }

  it("runs the sections/loaders/invoke generator on dev startup (debounced)", async () => {
    const p = Array.isArray(plugin()) ? plugin()[0] : plugin();
    const server = makeServer();
    p.configureServer(server);

    await vi.advanceTimersByTimeAsync(600);

    const scaffoldCalls = execCalls.filter((c) => c.includes("--only sections,loaders,invoke"));
    expect(scaffoldCalls).toHaveLength(1);
    expect(scaffoldCalls[0]).toContain("generate.ts");
  });

  it("debounces multiple src/ file-watcher events into a single regen call", async () => {
    const p = Array.isArray(plugin()) ? plugin()[0] : plugin();
    const server = makeServer();
    p.configureServer(server);

    // Consume the cold-start call first.
    await vi.advanceTimersByTimeAsync(600);
    execCalls.length = 0;

    const srcFile = path.join(tmp, "src", "sections", "Foo.tsx");
    server.watcher.emit("change", srcFile);
    server.watcher.emit("change", srcFile);
    server.watcher.emit("add", srcFile);

    await vi.advanceTimersByTimeAsync(600);

    const scaffoldCalls = execCalls.filter((c) => c.includes("--only sections,loaders,invoke"));
    expect(scaffoldCalls).toHaveLength(1);
  });

  it("does not trigger for a file outside src/", async () => {
    const p = Array.isArray(plugin()) ? plugin()[0] : plugin();
    const server = makeServer();
    p.configureServer(server);
    await vi.advanceTimersByTimeAsync(600);
    execCalls.length = 0;

    server.watcher.emit("change", path.join(tmp, "README.md"));
    await vi.advanceTimersByTimeAsync(600);

    expect(execCalls.filter((c) => c.includes("--only sections,loaders,invoke"))).toHaveLength(0);
  });
});
