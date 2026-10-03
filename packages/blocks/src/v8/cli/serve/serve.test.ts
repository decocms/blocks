// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { defineConformanceSuite } from "../../../protocol/conformance";
import { gitBlobHash } from "../../../protocol/storage/fs/hash";
import {
  createFixture,
  type Fixture,
  recorder,
  STORE_FILES,
  sealSecret,
} from "../__tests__/fixture";
import { decoPaths } from "../root";
import { type DecoMeta, generateSchema } from "../schema/generate";
import { DEFAULT_PREVIEW_URL, type RunningServer, startServer } from "./server";

let meta: DecoMeta;
beforeAll(async () => {
  const f = createFixture(STORE_FILES);
  try {
    ({ meta } = await generateSchema(decoPaths(f.root)));
  } finally {
    f.remove();
  }
}, 60_000);

let fixture: Fixture;
let server: RunningServer | undefined;
let out: ReturnType<typeof recorder>;
afterEach(async () => {
  await server?.close();
  server = undefined;
  fixture?.remove();
});

const TOKEN = "test-token";
const STUDIO = "https://studio.decocms.com";
const hero = { __resolveType: "hero", title: "Summer", size: "md" };

async function start(
  options: Parameters<typeof startServer>[0] = {},
  files: Record<string, string | object> = {},
) {
  fixture = createFixture(files);
  fs.mkdirSync(path.join(fixture.root, ".git"));
  fixture.write(".deco/schema.gen.json", meta);
  out = recorder();
  server = await startServer({
    cwd: fixture.root,
    port: 0,
    token: TOKEN,
    reporter: out,
    env: {},
    ...options,
  });
  return server;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
  raw: Buffer;
}

function request(
  method: string,
  pathname: string,
  { body, headers = {} }: { body?: string | Buffer; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const port = server!.port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let raw = Buffer.concat(chunks);
          if (res.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
          let parsed: any = null;
          try {
            parsed = JSON.parse(raw.toString("utf8"));
          } catch {
            parsed = raw.toString("utf8");
          }
          resolve({ status: res.statusCode!, headers: res.headers, body: parsed, raw });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
let nextId = 1;
async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
  const reply = await request("POST", "/rpc", {
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      ...(params === undefined ? {} : { params }),
    }),
    headers: { ...auth, ...headers },
  });
  return reply.body;
}

describe("starting", () => {
  it("prints the address, root, assets, app and site editor link", async () => {
    await start({ preview: "http://localhost:3001" });
    const text = out.text();
    expect(text).toContain(`Deco server          http://127.0.0.1:${server!.port}/rpc`);
    expect(text).toContain("Root                 .   (.deco/schema.gen.json, 0 blocks)");
    expect(text).toContain("Assets               public/assets   (PUT /assets/<name>)");
    expect(text).toContain("Preview              http://localhost:3001");
    expect(server!.siteEditorUrl).toBe(
      `https://studio.decocms.com/site-editor#endpoint=${encodeURIComponent(server!.endpoint)}&token=${TOKEN}`,
    );
  });

  it("uses DECO_SERVE_TOKEN, else a random token per run", async () => {
    await start({ token: undefined, env: { DECO_SERVE_TOKEN: "from-env" } });
    expect(server!.token).toBe("from-env");
    await server!.close();
    server = await startServer({ cwd: fixture.root, port: 0, reporter: out, env: {} });
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("warns when listening beyond loopback", async () => {
    await start({ host: "0.0.0.0" });
    expect(
      out.lines.some((l) => l.level === "warn" && /other machines can reach/.test(l.message)),
    ).toBe(true);
  });

  it("defaults the app to the Vite config's port, read as text, else 5173", async () => {
    await start({}, { "vite.config.ts": "export default { server: { port: 3999 } };" });
    expect(DEFAULT_PREVIEW_URL).toBe("http://localhost:5173");
    expect(out.text()).toContain("Preview              http://localhost:3999");
  });

  it("takes --preview as host:port or a loopback URL, and reports it in describe", async () => {
    await start({ preview: "localhost:8001" });
    expect(out.text()).toContain("Preview              http://localhost:8001");
    expect((await rpc("describe")).result.preview).toEqual({ url: "http://localhost:8001" });
    await server!.close();
    server = undefined;
    await start({ preview: "http://127.0.0.1:3000/en/" });
    expect((await rpc("describe")).result.preview).toEqual({ url: "http://127.0.0.1:3000/en/" });
  });

  it("refuses a --preview that isn't a local http(s) address", async () => {
    for (const bad of ["https://example.com", "file:///etc/passwd", "evil.test:80", "http://"]) {
      await expect(start({ preview: bad })).rejects.toThrow(/--preview must be a local address/);
    }
  });

  it("refuses an empty token", async () => {
    await expect(start({ token: "" })).rejects.toThrow(/--token can't be empty/);
    await expect(start({ token: undefined, env: { DECO_SERVE_TOKEN: "  " } })).rejects.toThrow(
      /DECO_SERVE_TOKEN can't be empty/,
    );
  });
});

describe("the security checks", () => {
  it("accepts only the site editor's origins and --allow-origin", async () => {
    await start({ allowOrigins: ["http://localhost:8000"] });
    const evil = await request("POST", "/rpc", {
      body: "{}",
      headers: { ...auth, origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    for (const origin of [STUDIO, "http://localhost:8000"]) {
      const ok = await request("POST", "/rpc", {
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
        headers: { ...auth, origin },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("answers the CORS and local-network preflight without a token", async () => {
    await start();
    const reply = await request("OPTIONS", "/rpc", {
      headers: {
        origin: STUDIO,
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true",
      },
    });
    expect(reply.status).toBe(204);
    expect(reply.headers["access-control-allow-origin"]).toBe(STUDIO);
    expect(reply.headers["access-control-allow-private-network"]).toBe("true");
    expect(reply.headers["access-control-allow-headers"]).toContain("authorization");
  });

  it("rejects any Host but its own address (DNS rebinding)", async () => {
    await start();
    const reply = await request("POST", "/rpc", {
      body: "{}",
      headers: { ...auth, host: "evil.example" },
    });
    expect(reply.status).toBe(403);
    const localhost = await request("POST", "/rpc", {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
      headers: { ...auth, host: `localhost:${server!.port}` },
    });
    expect(localhost.status).toBe(200);
  });
});

describe("the content protocol", () => {
  it("describes the endpoint: working tree, root, limits, assets and the secrets key", async () => {
    const { publicKeyPem } = await sealSecret("x");
    await start({ preview: "http://localhost:3000/" }, { ".deco/secrets.pub": publicKeyPem });
    const { result } = await rpc("describe");
    expect(result).toMatchObject({
      protocol: "deco-content",
      version: { major: 1 },
      server: { name: "deco-cli" },
      kind: "working-tree",
      readOnly: false,
      root: ".",
      schemaFormat: "deco-meta@1",
      refs: null,
      writes: { idempotency: null, schemaPreconditions: true },
      pollIntervalMs: 2000,
      limits: { maxOpsPerApply: 500, maxBlockBytes: 1048576, maxRequestBytes: 8388608 },
      preview: { url: "http://localhost:3000" },
      assets: { dir: "public/assets", urlPrefix: "/assets/", maxBytes: 25 * 1024 * 1024 },
      secrets: { publicKey: publicKeyPem },
    });
  });

  it("reports the app root relative to the repository root", async () => {
    fixture = createFixture();
    fs.mkdirSync(path.join(fixture.root, ".git"));
    fixture.write("apps/storefront/.deco/schema.gen.json", meta);
    out = recorder();
    server = await startServer({
      cwd: fixture.root,
      root: "apps/storefront",
      port: 0,
      token: TOKEN,
      reporter: out,
      env: {},
    });
    const { result } = await rpc("describe");
    expect(result.root).toBe("apps/storefront");
    expect(result.assets.dir).toBe("apps/storefront/public/assets");
    expect(result.secrets).toBeNull();
  });

  it("applies sets and deletes together, writes the file format, and regenerates the content module", async () => {
    await start({}, { ".deco/blocks/Old.json": hero });
    const result = (await rpc("blocks.apply", { set: { "a/b": hero }, delete: ["Old"] })).result;
    expect(fixture.read(".deco/blocks/a%2Fb.json")).toBe(`${JSON.stringify(hero, null, 2)}\n`);
    expect(fixture.exists(".deco/blocks/Old.json")).toBe(false);
    expect(result.versions).toEqual({
      "a/b": gitBlobHash(`${JSON.stringify(hero, null, 2)}\n`),
      Old: null,
    });
    expect((await rpc("blocks.list")).result.revision).toBe(result.revision);
    expect(fixture.read(".deco/blocks.gen.ts")).toContain('"a/b":');
  });

  it("regenerates the content module after editing an existing block, with a new revision", async () => {
    await start({}, { ".deco/blocks/HomePage.json": hero });
    await rpc("blocks.apply", { set: { HomePage: hero } });
    const revisionOf = () => fixture.read(".deco/blocks.gen.ts").match(/revision: "(\w+)"/)?.[1];
    const before = revisionOf();
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    await rpc("blocks.apply", { set: { HomePage: { ...hero, title: "Winter" } } });
    const after = revisionOf();
    expect(after).not.toBe(before);
    // Saving the same content again keeps the revision (and the file).
    await rpc("blocks.apply", { set: { HomePage: { ...hero, title: "Winter" } } });
    expect(revisionOf()).toBe(after);
  });

  it("says when it's read-only", async () => {
    await start({ readOnly: true });
    expect((await rpc("describe")).result).toMatchObject({ readOnly: true, assets: null });
    expect(out.text()).toContain("read-only: uploads are off");
  });
});

describe("uploads", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const put = (name: string, type = "image/png", body: Buffer = png) =>
    request("PUT", `/assets/${name}`, {
      body,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": type },
    });

  it("writes the file into public/assets and answers with the path the field stores", async () => {
    await start();
    const reply = await put("summer-banner.png");
    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({ path: "/assets/summer-banner.png" });
    expect(fs.readFileSync(path.join(fixture.root, "public/assets/summer-banner.png"))).toEqual(
      png,
    );
  });

  it("never overwrites: a taken name gets a short suffix", async () => {
    await start();
    await put("logo.png");
    const second = await put("logo.png");
    expect(second.body.path).toMatch(/^\/assets\/logo-[0-9a-f]{6}\.png$/);
    expect(fs.readdirSync(path.join(fixture.root, "public/assets"))).toHaveLength(2);
  });

  it("writes to --assets, relative to the root", async () => {
    await start({ assets: "static/uploads" });
    const reply = await put("a.pdf", "application/pdf");
    expect(reply.body.path).toBe("/assets/a.pdf");
    expect(fixture.exists("static/uploads/a.pdf")).toBe(true);
  });

  it("refuses a name whose extension doesn't match the declared type, and SVG", async () => {
    await start();
    const html = await put("page.html", "image/png");
    expect(html.status).toBe(415);
    expect((await put("photo.png", "image/jpeg")).status).toBe(415);
    const svg = await put("logo.svg", "image/svg+xml", Buffer.from("<svg/>"));
    expect(svg.status).toBe(415);
    expect(fs.existsSync(path.join(fixture.root, "public/assets"))).toBe(false);
    // A name without an extension gets its type's.
    expect((await put("noext", "image/png")).body.path).toBe("/assets/noext.png");
    expect((await put("Photo.JPG", "image/jpeg")).status).toBe(201);
    expect((await put("font.woff2", "font/woff2")).status).toBe(201);
    expect((await put("clip.mp4", "video/mp4")).status).toBe(201);
  });
});

describe("the content protocol's conformance suite, against deco serve", () => {
  let site: Fixture;
  let running: RunningServer;
  let readOnly: RunningServer;
  let publicKeyPem: string;
  beforeAll(async () => {
    ({ publicKeyPem } = await sealSecret("x"));
    site = createFixture({ ".deco/schema.gen.json": meta, ".deco/secrets.pub": publicKeyPem });
    const options = { cwd: site.root, port: 0, token: TOKEN, reporter: recorder(), env: {} };
    running = await startServer(options);
    readOnly = await startServer({ ...options, readOnly: true });
  });
  afterAll(async () => {
    await running?.close();
    await readOnly?.close();
    site?.remove();
  });

  const optionsFor = (server: () => RunningServer) => () => ({
    endpoint: server().endpoint,
    assetsEndpoint: server().endpoint.replace(/\/rpc$/, "/assets/"),
    token: TOKEN,
    secretField: { blockType: "hero", field: "apiKey" },
    secretsPublicKey: publicKeyPem,
  });
  defineConformanceSuite(
    { describe, it },
    optionsFor(() => running),
  );
  defineConformanceSuite(
    { describe, it },
    optionsFor(() => readOnly),
    "content protocol conformance, read-only",
    (testCase) => testCase.id.endsWith("/read-only"),
  );
});
