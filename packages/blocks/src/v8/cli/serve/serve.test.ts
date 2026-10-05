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
    reporter: out,
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
  {
    body,
    headers = {},
    noHost = false,
  }: { body?: string | Buffer; headers?: Record<string, string>; noHost?: boolean } = {},
): Promise<Reply> {
  const port = server!.port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers: noHost ? headers : { host: `127.0.0.1:${port}`, ...headers },
        setHost: !noHost,
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

const json = { "content-type": "application/json" };
let nextId = 1;
async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
  const reply = await request("POST", "/rpc", {
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      ...(params === undefined ? {} : { params }),
    }),
    headers: { ...json, ...headers },
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
      `https://studio.decocms.com/site-editor#endpoint=${encodeURIComponent(server!.endpoint)}`,
    );
    expect(text).toContain(`Site editor          ${server!.siteEditorUrl}`);
  });

  it("has no token: nothing about one in its output, and DECO_SERVE_TOKEN is ignored", async () => {
    process.env.DECO_SERVE_TOKEN = "from-env";
    try {
      await start();
    } finally {
      delete process.env.DECO_SERVE_TOKEN;
    }
    expect("token" in server!).toBe(false);
    expect(server!.siteEditorUrl).not.toMatch(/token/i);
    expect(out.text()).not.toMatch(/token/i);
    const reply = await request("POST", "/rpc", {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
      headers: { ...json, authorization: "Bearer from-env" },
    });
    expect(reply.status).toBe(200);
    expect(reply.body.result.protocol).toBe("deco-content");
  });

  it("warns when listening beyond loopback, and accepts its own Host there", async () => {
    await start({ host: "0.0.0.0" });
    const warnings = out.lines.filter((l) => l.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/other machines on the network can reach this server/);
    expect(warnings[0].message).not.toMatch(/token/i);
    // The site editor connects through loopback, never the wildcard address.
    expect(server!.siteEditorUrl).toBe(
      `https://studio.decocms.com/site-editor#endpoint=${encodeURIComponent(`http://127.0.0.1:${server!.port}/rpc`)}`,
    );
    const describe = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" });
    for (const host of [`0.0.0.0:${server!.port}`, `localhost:${server!.port}`]) {
      const reply = await request("POST", "/rpc", { body: describe, headers: { ...json, host } });
      expect(reply.status, host).toBe(200);
    }
    const evil = await request("POST", "/rpc", {
      body: describe,
      headers: { ...json, host: "evil.com" },
    });
    expect(evil.status).toBe(403);
  });

  it("reads --host case-insensitively", async () => {
    await start({ host: "LOCALHOST" });
    expect(out.lines.filter((l) => l.level === "warn")).toEqual([]);
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
});

describe("the security checks", () => {
  it("accepts only the site editor's origins and --allow-origin", async () => {
    await start({ allowOrigins: ["http://localhost:8000"] });
    const evil = await request("POST", "/rpc", {
      body: "{}",
      headers: { ...json, origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    await request("POST", "/rpc", {
      body: "{}",
      headers: { ...json, origin: "https://evil.example" },
    });
    const refusals = out.lines.filter(
      (l) => l.level === "warn" && /refused a request/.test(l.message),
    );
    expect(refusals.map((l) => l.message)).toEqual([
      "refused a request from https://evil.example; to allow it, pass --allow-origin https://evil.example",
    ]);
    for (const origin of [STUDIO, "http://localhost:8000"]) {
      const ok = await request("POST", "/rpc", {
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
        headers: { ...json, origin },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("accepts a request without Origin (a local process)", async () => {
    await start();
    const reply = await request("POST", "/rpc", {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
      headers: json,
    });
    expect(reply.status).toBe(200);
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers the CORS and local-network preflight", async () => {
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
    expect(reply.headers["access-control-allow-headers"]).toBe("content-type");
    const foreign = await request("OPTIONS", "/rpc", {
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true",
      },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers["access-control-allow-private-network"]).toBeUndefined();
  });

  it("rejects any Host but its own address (DNS rebinding)", async () => {
    await start();
    const port = server!.port;
    const describe = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" });
    for (const host of [
      "evil.com",
      `evil.com:${port}`,
      "127.0.0.1.evil.com",
      `127.0.0.1.evil.com:${port}`,
      `localhost:${port + 1}`,
    ]) {
      const reply = await request("POST", "/rpc", { body: describe, headers: { ...json, host } });
      expect(reply.status, host).toBe(403);
    }
    const missing = await request("POST", "/rpc", { body: describe, headers: json, noHost: true });
    // Node's HTTP server answers 400 before the handler runs: HTTP/1.1 requires Host.
    expect(missing.status).toBe(400);
    const upload = await request("PUT", "/assets/a.png", {
      body: Buffer.from([1]),
      headers: { "content-type": "image/png", host: "evil.com" },
    });
    expect(upload.status).toBe(403);
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      const reply = await request("POST", "/rpc", { body: describe, headers: { ...json, host } });
      expect(reply.status, host).toBe(200);
    }
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
      reporter: out,
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
      headers: { "content-type": type },
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
    const options = { cwd: site.root, port: 0, reporter: recorder() };
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
