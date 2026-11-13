import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let schemaGenError = null;

vi.mock("node:child_process", () => {
  const exec = (cmd, _opts, cb) => {
    cb(cmd.includes("generate-schema.ts") ? schemaGenError : null, "", "");
  };
  const execFileSync = () => "";
  return { exec, execFileSync, default: { exec, execFileSync } };
});

/**
 * The staff-only admin routes (`/live/_meta`, `/.decofile`, `/live/previews`)
 * were hard-removed from the TanStack worker entry. The dev plugin must not
 * keep talking to them: no POST to `/.decofile` after a regen, and no CORS
 * preflight shim answering for those paths in front of Vite.
 */
describe("decoVitePlugin — dev server no longer talks to removed admin routes", () => {
  let tmp;
  let cwdSpy;
  let fetchSpy;
  let plugin;
  let middlewares;

  beforeEach(async () => {
    vi.resetModules();
    schemaGenError = null;
    middlewares = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-dev-admin-"));
    // Present, so the synchronous cold-start generation is skipped.
    fs.mkdirSync(path.join(tmp, ".deco"));
    fs.writeFileSync(path.join(tmp, ".deco", "meta.gen.json"), "{}");
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    vi.useFakeTimers();
    ({ decoVitePlugin: plugin } = await import("./plugin.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
    cwdSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function startServer({ stack = middlewares } = {}) {
    const p = Array.isArray(plugin()) ? plugin()[0] : plugin();
    const server = {
      watcher: new EventEmitter(),
      middlewares: { stack },
      config: { define: {} },
      environments: undefined,
      httpServer: { once: () => {}, address: () => ({ port: 4321 }) },
    };
    p.configureServer(server);
    return server;
  }

  const decofilePosts = () =>
    fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/.decofile"));

  it("does not POST to /.decofile after meta.gen.json is regenerated", async () => {
    const server = startServer();
    server.watcher.emit("change", path.join(tmp, "src", "sections", "Foo.tsx"));
    await vi.advanceTimersByTimeAsync(600);

    expect(decofilePosts()).toHaveLength(0);
  });

  it("does not POST when schema generation fails either", async () => {
    schemaGenError = new Error("ts-morph exploded");
    const server = startServer();
    server.watcher.emit("change", path.join(tmp, "src", "sections", "Foo.tsx"));
    await vi.advanceTimersByTimeAsync(600);

    expect(decofilePosts()).toHaveLength(0);
  });

  it("installs no admin preflight middleware in front of Vite", () => {
    startServer();
    expect(middlewares).toHaveLength(0);
  });

  it("still starts when the middleware stack isn't connect's array", () => {
    expect(() => startServer({ stack: undefined })).not.toThrow();
  });
});
