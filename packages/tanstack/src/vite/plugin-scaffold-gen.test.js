import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execCalls = [];
const execFileSyncCalls = [];
// When `hold.on`, exec doesn't complete: its callback waits in `hold.pending`
// so a test can observe how many "children" are in flight at once.
const hold = { on: false, pending: [] };

vi.mock("node:child_process", () => {
  const exec = (cmd, _opts, cb) => {
    execCalls.push(cmd);
    if (hold.on) hold.pending.push({ cmd, done: () => cb(null, "", "") });
    else cb(null, "", "");
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
    // The single-flight registry is process-wide by design; reset it per test.
    delete globalThis[Symbol.for("deco.devRegens")];
    hold.on = false;
    hold.pending.length = 0;
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
      httpServer: new EventEmitter(),
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

  it("ignores src files neither generator reads (incl. its own invoke.gen.ts output)", async () => {
    const p = Array.isArray(plugin()) ? plugin()[0] : plugin();
    const server = makeServer();
    p.configureServer(server);
    await vi.advanceTimersByTimeAsync(600);
    execCalls.length = 0;

    for (const f of [
      "server/chat.ts",
      "server/invoke.gen.ts",
      "components/Card.tsx",
      "routes/index.tsx",
    ]) {
      server.watcher.emit("change", path.join(tmp, "src", f));
    }
    await vi.advanceTimersByTimeAsync(600);

    expect(execCalls).toHaveLength(0);
  });
});

/**
 * Regression guard for the dev process storm: a `vite dev` left up ~3h while
 * an agent edited src/ ended with ~15 concurrent generate-schema/generate
 * children at ~99% CPU. Vite's restartServer() runs a FRESH configureServer
 * (new plugin instance) before closing the old server, so per-closure
 * single-flight flags reset on every restart while the old children kept
 * running. Each restart below is a new decoVitePlugin() + configureServer,
 * exactly like a config re-load.
 */
describe("decoVitePlugin — dev regenerators stay single-flight across restarts", () => {
  let tmp;
  let decoVitePlugin;

  beforeEach(async () => {
    vi.resetModules();
    delete globalThis[Symbol.for("deco.devRegens")];
    hold.on = true;
    hold.pending.length = 0;
    execCalls.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-regen-storm-"));
    // Present, so the synchronous cold-start schema pass (execFileSync) is skipped.
    fs.mkdirSync(path.join(tmp, ".deco"));
    fs.writeFileSync(path.join(tmp, ".deco", "meta.gen.json"), "{}");
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
    vi.useFakeTimers();
    ({ decoVitePlugin } = await import("./plugin.js"));
  });

  afterEach(() => {
    hold.on = false;
    vi.useRealTimers();
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function startServer() {
    const server = {
      watcher: new EventEmitter(),
      config: { define: {} },
      environments: undefined,
      httpServer: new EventEmitter(),
    };
    const p = decoVitePlugin();
    (Array.isArray(p) ? p[0] : p).configureServer(server);
    return server;
  }
  const inFlight = (script) => hold.pending.filter((r) => r.cmd.includes(script)).length;
  const finishAll = () => {
    for (const r of hold.pending.splice(0)) r.done();
  };

  it("never runs more than one generate-schema and one generate at a time", async () => {
    let prev;
    for (let i = 0; i < 5; i++) {
      // Vite creates the new server before closing the old one.
      const server = startServer();
      for (let j = 0; j < 10; j++) {
        server.watcher.emit("change", path.join(tmp, "src", "sections", `S${j}.tsx`));
        server.watcher.emit("change", path.join(tmp, "src", "loaders", `L${j}.ts`));
      }
      await vi.advanceTimersByTimeAsync(600);
      prev?.httpServer.emit("close");
      prev = server;
      expect(inFlight("generate-schema.ts")).toBe(1);
      expect(inFlight("generate.ts")).toBe(1);
    }

    // Everything that arrived while busy collapses into ONE follow-up each.
    finishAll();
    await vi.advanceTimersByTimeAsync(600);
    expect(inFlight("generate-schema.ts")).toBe(1);
    expect(inFlight("generate.ts")).toBe(1);
    finishAll();
    await vi.advanceTimersByTimeAsync(600);
    expect(hold.pending).toHaveLength(0);
    expect(execCalls).toHaveLength(4);
  });

  it("drops pending runs when the owning server closes for good", async () => {
    const server = startServer();
    server.watcher.emit("change", path.join(tmp, "src", "sections", "Foo.tsx"));
    server.httpServer.emit("close");
    await vi.advanceTimersByTimeAsync(600);
    expect(execCalls).toHaveLength(0);
  });
});
