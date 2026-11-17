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
 * The isolate keeps the composed admin schema on globalThis, which outlives
 * the meta.gen.json module the plugin invalidates after a dev regen. Without a
 * decofile reload (the only caller of invalidateMetaCache), `/live/_meta` kept
 * serving the boot-time schema, so a changed section's props never reached the
 * admin form until the dev server restarted.
 */
describe("decoVitePlugin — dev admin reads from Studio", () => {
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

  it("posts an empty decofile delta after meta.gen.json is regenerated", async () => {
    const server = startServer();
    server.watcher.emit("change", path.join(tmp, "src", "sections", "Foo.tsx"));
    await vi.advanceTimersByTimeAsync(600);

    const posts = decofilePosts();
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0];
    expect(url).toBe("http://localhost:4321/.decofile");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ blocks: {} });
  });

  it("does not post when schema generation fails", async () => {
    schemaGenError = new Error("ts-morph exploded");
    const server = startServer();
    server.watcher.emit("change", path.join(tmp, "src", "sections", "Foo.tsx"));
    await vi.advanceTimersByTimeAsync(600);

    expect(decofilePosts()).toHaveLength(0);
  });

  /** Runs a request through the front of the stack, ahead of Vite's CORS. */
  function preflight(method, url, origin) {
    startServer();
    const res = {
      statusCode: 200,
      headers: {},
      ended: false,
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end() {
        this.ended = true;
      },
    };
    let passed = false;
    middlewares[0].handle({ method, url, headers: { origin } }, res, () => {
      passed = true;
    });
    return { res, passed };
  }

  it("answers an admin preflight from Studio before Vite's CORS ends it", () => {
    const { res, passed } = preflight("OPTIONS", "/live/_meta?x=1", "https://studio.decocms.com");
    expect(passed).toBe(false);
    expect(res.ended).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://studio.decocms.com");
    expect(res.headers["Access-Control-Allow-Headers"]).toContain("If-None-Match");
  });

  it("leaves other requests to Vite", () => {
    expect(preflight("GET", "/live/_meta", "https://studio.decocms.com").passed).toBe(true);
    expect(preflight("OPTIONS", "/src/main.tsx", "https://studio.decocms.com").passed).toBe(true);
    expect(preflight("OPTIONS", "/live/previews/", "https://studio.decocms.com").passed).toBe(true);
  });

  it("still starts when the middleware stack isn't connect's array", () => {
    expect(() => startServer({ stack: undefined })).not.toThrow();
  });
});
