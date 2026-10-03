// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createFixture,
  type Fixture,
  recorder,
  STORE_FILES,
  sealSecret,
} from "../__tests__/fixture";
import { decoPaths } from "../root";
import { type DecoMeta, generateSchema } from "../schema/generate";
import { DEFAULT_APP_URL, type RunningServer, sanitizeAssetName, startServer } from "./server";
import { gitBlobHash } from "./storage";

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
  it("prints the address, root, assets, app and connect link", async () => {
    await start({ appUrl: "http://localhost:3001" });
    const text = out.text();
    expect(text).toContain(`Deco server          http://127.0.0.1:${server!.port}/rpc`);
    expect(text).toContain("Root                 .   (.deco/schema.gen.json, 0 blocks)");
    expect(text).toContain("Assets               public/assets   (PUT /assets/<name>)");
    expect(text).toContain("App preview          http://localhost:3001");
    expect(server!.connectUrl).toBe(
      `https://studio.decocms.com/connect#endpoint=${encodeURIComponent(server!.endpoint)}&token=${TOKEN}`,
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

  it("defaults the app to 5173 without reading any framework config", async () => {
    await start({}, { "vite.config.ts": "export default { server: { port: 3999 } };" });
    expect(DEFAULT_APP_URL).toBe("http://localhost:5173");
    expect(out.text()).toContain("App preview          http://localhost:5173");
  });

  it("refuses an empty token", async () => {
    await expect(start({ token: "" })).rejects.toThrow(/--token can't be empty/);
    await expect(start({ token: undefined, env: { DECO_SERVE_TOKEN: "  " } })).rejects.toThrow(
      /DECO_SERVE_TOKEN can't be empty/,
    );
  });
});

describe("the security checks", () => {
  it("requires the bearer token (401)", async () => {
    await start();
    const reply = await request("POST", "/rpc", {
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "describe" }),
      headers: { "content-type": "application/json" },
    });
    expect(reply.status).toBe(401);
    expect(reply.body.error.code).toBe(-32010);
    const wrong = await request("POST", "/rpc", {
      body: "{}",
      headers: { ...auth, authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

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

  it("rejects a Content-Type other than JSON (cross-site form posts)", async () => {
    await start();
    const reply = await request("POST", "/rpc", {
      body: "a=1",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
    });
    expect(reply.status).toBe(415);
  });

  it("rejects a body over the limit (413)", async () => {
    await start();
    const reply = await request("POST", "/rpc", {
      body: Buffer.alloc(8 * 1024 * 1024 + 10, 32),
      headers: auth,
    });
    expect(reply.status).toBe(413);
  });
});

describe("the content protocol", () => {
  it("describes the endpoint: working tree, root, limits, assets and the secrets key", async () => {
    const { publicKeyPem } = await sealSecret("x");
    await start({ appUrl: "http://localhost:3000/" }, { ".deco/secrets.pub": publicKeyPem });
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
      writes: { idempotency: null, schemaPreconditions: false },
      pollIntervalMs: 2000,
      limits: { maxOpsPerApply: 500, maxBlockBytes: 1048576, maxRequestBytes: 8388608 },
      preview: { origin: "http://localhost:3000" },
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

  it("serves the schema, and 'not modified' for the version the client has", async () => {
    await start();
    const first = (await rpc("schema.get")).result;
    expect(first.notModified).toBe(false);
    expect(first.schema.format).toBe("deco-meta@1");
    expect(first.version).toBe(gitBlobHash(fixture.read(".deco/schema.gen.json")));
    expect((await rpc("schema.get", { ifNoneMatch: first.version })).result).toEqual({
      notModified: true,
      version: first.version,
    });
  });

  it("falls back to meta.gen.json, and reports a missing schema as NotFound", async () => {
    await start();
    fs.renameSync(
      path.join(fixture.root, ".deco/schema.gen.json"),
      path.join(fixture.root, ".deco/meta.gen.json"),
    );
    expect((await rpc("schema.get")).result.schema.format).toBe("deco-meta@1");
    fs.rmSync(path.join(fixture.root, ".deco/meta.gen.json"));
    expect((await rpc("schema.get")).error.code).toBe(-32001);
  });

  it("lists every saved block with one version each and a revision", async () => {
    await start({}, { ".deco/blocks/Summer.json": hero });
    const list = (await rpc("blocks.list")).result;
    expect(list.blocks).toEqual({ Summer: hero });
    expect(list.versions.Summer).toBe(gitBlobHash(fixture.read(".deco/blocks/Summer.json")));
    expect((await rpc("blocks.list", { ifNoneMatch: list.revision })).result).toEqual({
      notModified: true,
      revision: list.revision,
      resolvedRef: null,
    });
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

  it("saves, lists and deletes blocks named constructor and toString", async () => {
    await start();
    const saved = await rpc("blocks.apply", { set: { constructor: hero, toString: hero } });
    expect(saved.error).toBeUndefined();
    expect(fixture.exists(".deco/blocks/constructor.json")).toBe(true);
    expect(fixture.exists(".deco/blocks/toString.json")).toBe(true);
    const list = (await rpc("blocks.list")).result;
    expect(Object.keys(list.blocks).sort()).toEqual(["constructor", "toString"]);
    const edited = await rpc("blocks.apply", {
      set: { constructor: { ...hero, title: "x" } },
      ifMatch: { constructor: list.versions.constructor },
    });
    expect(edited.error).toBeUndefined();
    expect(JSON.parse(fixture.read(".deco/blocks/constructor.json")).title).toBe("x");
    expect(
      (await rpc("blocks.apply", { set: { valueOf: hero }, ifMatch: { valueOf: null } })).error,
    ).toBeUndefined();
    await rpc("blocks.apply", { delete: ["toString", "hasOwnProperty"] });
    expect(fixture.exists(".deco/blocks/toString.json")).toBe(false);
    const refused = await rpc("blocks.apply", {
      set: JSON.parse('{"__proto__": {"__resolveType": "hero"}}'),
    });
    expect(refused.error.code).toBe(-32003);
  });

  it("lets set win over delete for the same name", async () => {
    await start({}, { ".deco/blocks/A.json": hero });
    await rpc("blocks.apply", { set: { A: { ...hero, title: "new" } }, delete: ["A"] });
    expect(JSON.parse(fixture.read(".deco/blocks/A.json")).title).toBe("new");
  });

  it("overwrites the winning spelling and deletes the others", async () => {
    await start(
      {},
      {
        ".deco/blocks/pages-Home%2520Page.json": { ...hero, path: "/" },
        ".deco/blocks/pages-Home%20Page.json": hero,
      },
    );
    await rpc("blocks.apply", { set: { "pages-Home%20Page": { ...hero, title: "x" } } });
    expect(fs.readdirSync(path.join(fixture.root, ".deco/blocks"))).toEqual([
      "pages-Home%2520Page.json",
    ]);
  });

  it("writes nothing on a failed ifMatch, and supports create-only with null", async () => {
    await start({}, { ".deco/blocks/A.json": hero });
    const conflict = await rpc("blocks.apply", {
      set: { A: { ...hero, title: "x" } },
      ifMatch: { A: "stale" },
    });
    expect(conflict.error.code).toBe(-32002);
    expect(conflict.error.data.conflicts).toEqual([
      { name: "A", expected: "stale", actual: gitBlobHash(fixture.read(".deco/blocks/A.json")) },
    ]);
    expect(JSON.parse(fixture.read(".deco/blocks/A.json")).title).toBe("Summer");
    expect((await rpc("blocks.apply", { set: { A: hero }, ifMatch: { A: null } })).error.code).toBe(
      -32002,
    );
    expect(
      (await rpc("blocks.apply", { set: { B: hero }, ifMatch: { B: null } })).result,
    ).toBeDefined();
  });

  it("validates every operation first and reports all violations at once", async () => {
    await start({}, { ".deco/blocks/HomePage.json": hero });
    const reply = await rpc("blocks.apply", {
      set: {
        "": hero,
        "a\\b": hero,
        homepage: hero,
        "x.tsx": hero,
        ok: "not an object",
        noType: { title: 1 },
      },
    });
    expect(reply.error.code).toBe(-32003);
    expect(reply.error.data.violations.map((v: any) => v.name)).toEqual([
      "",
      "a\\b",
      "homepage",
      "x.tsx",
      "ok",
      "noType",
    ]);
    expect(fs.readdirSync(path.join(fixture.root, ".deco/blocks"))).toEqual(["HomePage.json"]);
  });

  it("refuses plain text in a Secret field (the secret guard)", async () => {
    await start();
    const plain = await rpc("blocks.apply", { set: { A: { ...hero, apiKey: "sk_live" } } });
    expect(plain.error.code).toBe(-32003);
    expect(plain.error.data.violations[0]).toMatchObject({ name: "A", path: "apiKey" });
    const { ciphertext } = await sealSecret("sk_live");
    const sealed = await rpc("blocks.apply", {
      set: { A: { ...hero, apiKey: { __resolveType: "secret", ciphertext } } },
    });
    expect(sealed.result).toBeDefined();
  });

  it("rejects unknown parameters, missing ids, unsupported guards and branches", async () => {
    await start();
    expect((await rpc("blocks.list", { since: 1 })).error.code).toBe(-32602);
    expect((await rpc("blocks.list", { ref: "main" })).error.code).toBe(-32006);
    expect((await rpc("blocks.apply", { requestKey: "k", set: {} })).error.code).toBe(-32006);
    expect((await rpc("blocks.apply", { ifSchemaMatch: "v", set: {} })).error.code).toBe(-32006);
    expect((await rpc("nope")).error.code).toBe(-32601);
    const noId = await request("POST", "/rpc", {
      body: JSON.stringify({ jsonrpc: "2.0", method: "describe" }),
      headers: auth,
    });
    expect(noId.body.error.code).toBe(-32600);
    const broken = await request("POST", "/rpc", { body: "{", headers: auth });
    expect(broken.body.error.code).toBe(-32700);
  });

  it("runs a batch in order, up to ten calls, and gzips large answers", async () => {
    await start({}, { ".deco/blocks/A.json": hero });
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "schema.get" },
      { jsonrpc: "2.0", id: 2, method: "blocks.list" },
    ];
    const reply = await request("POST", "/rpc", {
      body: JSON.stringify(batch),
      headers: { ...auth, "accept-encoding": "gzip" },
    });
    expect(reply.headers["content-encoding"]).toBe("gzip");
    expect(reply.body.map((r: any) => r.id)).toEqual([1, 2]);
    const tooMany = await request("POST", "/rpc", {
      body: JSON.stringify(
        Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "describe" })),
      ),
      headers: auth,
    });
    expect(tooMany.body.error.code).toBe(-32007);
  });

  it("refuses writes and uploads when read-only", async () => {
    await start({ readOnly: true });
    expect((await rpc("describe")).result).toMatchObject({ readOnly: true, assets: null });
    expect((await rpc("blocks.apply", { set: { A: hero } })).error.code).toBe(-32005);
    const upload = await request("PUT", "/assets/a.png", {
      body: Buffer.from([1]),
      headers: { ...auth, "content-type": "image/png" },
    });
    expect(upload.status).toBe(403);
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

  it("takes only image, video, font and PDF types, and safe names", async () => {
    await start();
    expect((await put("a.html", "text/html")).status).toBe(415);
    expect((await put("..%2F..%2Fescape.png")).status).toBe(400);
    expect(sanitizeAssetName("Summer Banner (1).png")).toBe("Summer-Banner-1-.png");
    expect(sanitizeAssetName("..")).toBeNull();
    expect(sanitizeAssetName(".env")).toBe("env");
  });

  it("refuses a name whose extension doesn't match the declared type, and SVG", async () => {
    await start();
    const html = await put("page.html", "image/png");
    expect(html.status).toBe(415);
    expect(html.body.error.message).toBe("a file of type image/png must be named *.png");
    expect((await put("photo.png", "image/jpeg")).status).toBe(415);
    expect((await put("noext", "image/png")).status).toBe(415);
    const svg = await put("logo.svg", "image/svg+xml", Buffer.from("<svg/>"));
    expect(svg.status).toBe(415);
    expect(svg.body.error.message).toMatch(/SVG/);
    expect(fs.existsSync(path.join(fixture.root, "public/assets"))).toBe(false);
    expect((await put("Photo.JPG", "image/jpeg")).status).toBe(201);
    expect((await put("font.woff2", "font/woff2")).status).toBe(201);
    expect((await put("clip.mp4", "video/mp4")).status).toBe(201);
  });

  it("requires the token, like every request", async () => {
    await start();
    const reply = await request("PUT", "/assets/a.png", {
      body: png,
      headers: { "content-type": "image/png" },
    });
    expect(reply.status).toBe(401);
  });
});
