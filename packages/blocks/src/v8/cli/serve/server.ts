/**
 * `deco serve`: the local server the site editor uses to edit the files on
 * this machine (spec: cli › deco serve; content-protocol › The local server).
 *
 * The HTTP layer owns the security checks; the content protocol itself is
 * `createLocalContentHandler` over the working tree.
 *
 * - Listens on 127.0.0.1 unless `--host` says otherwise (with a warning).
 * - Every request carries the bearer token (random per run, or `--token` /
 *   `DECO_SERVE_TOKEN`), except CORS preflights.
 * - Browser requests are accepted only from the site editor's origins and
 *   `--allow-origin`; Chrome's local-network preflight is answered.
 * - Any `Host` other than the server's own address is refused (DNS
 *   rebinding), and so is any `Content-Type` other than JSON on `/rpc`
 *   (cross-site form posts). Uploads, `PUT /assets/<name>`, take the file's
 *   own image, video, font or PDF type instead.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { writeContent } from "../content";
import { consoleReporter, type Reporter } from "../log";
import { CliError, decoPaths, findDecoRoot, findRepositoryRoot, relativePosix } from "../root";
import { createLocalContentHandler, ERRORS } from "./handler";
import { createFsStorage } from "./storage";

/** The site editor's origins: the browser origins allowed by default. */
const STUDIO_ORIGINS = [
  "https://studio.decocms.com",
  "https://admin.decocms.com",
  "https://admin.deco.cx",
];

/** Where the connect link points. `DECO_STUDIO_ORIGIN` overrides it (staging, local Studio). */
function studioOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return env.DECO_STUDIO_ORIGIN?.replace(/\/+$/, "") || STUDIO_ORIGINS[0];
}

const DEFAULT_PORT = 4545;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_ASSETS = "public/assets";
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_RPC_BYTES = 8 * 1024 * 1024;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface ServeOptions {
  root?: string;
  cwd?: string;
  port?: number;
  host?: string;
  appUrl?: string;
  token?: string;
  allowOrigins?: string[];
  /** The upload folder, relative to the folder that contains `.deco`. */
  assets?: string;
  readOnly?: boolean;
  reporter?: Reporter;
  env?: NodeJS.ProcessEnv;
}

export interface RunningServer {
  /** The content protocol endpoint, `http://127.0.0.1:4545/rpc`. */
  endpoint: string;
  token: string;
  connectUrl: string;
  port: number;
  close(): Promise<void>;
}

/**
 * The dev app the canvas opens when `--app-url` isn't given. The CLI doesn't
 * read framework config to guess it: knowing a framework's dev port belongs
 * to that framework's binding, which can pass `appUrl` to `startServer`.
 */
export const DEFAULT_APP_URL = "http://localhost:5173";

function packageVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"))
      .version;
  } catch {
    return "0.0.0";
  }
}

/**
 * The uploads the server takes: each content type with the file extensions
 * that match it. The dev app serves uploads from its own origin, so a file
 * whose extension doesn't match its declared type (an `.html` sent as
 * `image/png`) is refused, and so is SVG, an image format that can run
 * script.
 */
const UPLOAD_TYPES: Record<string, readonly string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "image/avif": [".avif"],
  "image/x-icon": [".ico"],
  "image/vnd.microsoft.icon": [".ico"],
  "video/mp4": [".mp4", ".m4v"],
  "video/webm": [".webm"],
  "video/quicktime": [".mov"],
  "font/woff": [".woff"],
  "font/woff2": [".woff2"],
  "font/ttf": [".ttf"],
  "font/otf": [".otf"],
  "application/font-woff": [".woff"],
  "application/font-woff2": [".woff2"],
  "application/pdf": [".pdf"],
};

/** Why an upload of `type` named `name` is refused, or null when it's accepted. */
function uploadProblem(type: string, name: string): string | null {
  if (type === "image/svg+xml") return "SVG uploads aren't accepted: an SVG file can run script";
  const extensions = Object.hasOwn(UPLOAD_TYPES, type) ? UPLOAD_TYPES[type] : undefined;
  if (!extensions) return "uploads take an image, video, font or PDF content type";
  const ext = path.extname(name).toLowerCase();
  return extensions.includes(ext)
    ? null
    : `a file of type ${type} must be named ${extensions.map((e) => `*${e}`).join(" or ")}`;
}

/** A file name safe to write: one segment, no traversal, portable characters. */
export function sanitizeAssetName(raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  name = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-");
  name = name.replace(/^[.-]+/, "");
  if (!name || name === "." || name.includes("..")) return null;
  return name.slice(-200);
}

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Start the server; resolves once it listens. */
export async function startServer(options: ServeOptions = {}): Promise<RunningServer> {
  const reporter = options.reporter ?? consoleReporter;
  const env = options.env ?? process.env;
  const paths = decoPaths(findDecoRoot(options));
  const repoRoot = findRepositoryRoot(paths.root);
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const readOnly = options.readOnly ?? false;
  if (options.token !== undefined && options.token.trim() === "") {
    throw new CliError("--token can't be empty: pass a token, or leave it out for a random one");
  }
  if (options.token === undefined && env.DECO_SERVE_TOKEN?.trim() === "") {
    throw new CliError(
      "DECO_SERVE_TOKEN can't be empty: set a token, or unset it for a random one",
    );
  }
  const token = options.token ?? env.DECO_SERVE_TOKEN ?? randomBytes(32).toString("base64url");
  const appUrl = options.appUrl ?? DEFAULT_APP_URL;
  const assetsDir = path.resolve(paths.root, options.assets ?? DEFAULT_ASSETS);
  const allowedOrigins = new Set(
    [...STUDIO_ORIGINS, studioOrigin(env), ...(options.allowOrigins ?? [])].map((o) =>
      o.replace(/\/+$/, ""),
    ),
  );

  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new CliError(`--port must be a port number, got ${requestedPort}`);
  }
  try {
    new URL(appUrl);
  } catch {
    throw new CliError(`--app-url must be a URL, got ${appUrl}`);
  }

  const storage = createFsStorage(paths);
  const handler = createLocalContentHandler(storage, {
    readOnly,
    root: relativePosix(repoRoot, paths.root),
    serverVersion: packageVersion(),
    previewOrigin: new URL(appUrl).origin,
    assets: { dir: relativePosix(repoRoot, assetsDir), maxBytes: MAX_ASSET_BYTES },
    secretsPublicKey: () => {
      try {
        return fs.readFileSync(paths.secretsPublicKey, "utf8");
      } catch {
        return null;
      }
    },
    onApply(result) {
      const names = Object.keys(result.versions);
      reporter.info(
        `saved ${names.length} block${names.length === 1 ? "" : "s"}: ${names.join(", ")}`,
      );
      // Every save changes the content, so the content module's revision
      // changes too (a revision is never reused for different content). An
      // unchanged module isn't rewritten, so this costs nothing when it isn't.
      try {
        writeContent(paths);
      } catch (error) {
        reporter.warn(`couldn't regenerate .deco/blocks.gen.ts: ${(error as Error).message}`);
      }
    },
  });

  let port = requestedPort;
  const allowedHosts = () => {
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!LOOPBACK.has(host)) hosts.add(`${host.includes(":") ? `[${host}]` : host}:${port}`);
    return hosts;
  };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> = {};
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      let payload: Buffer = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...cors,
        ...extra,
      };
      if (payload.length > 1024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
        payload = gzipSync(payload);
        headers["content-encoding"] = "gzip";
      }
      headers["content-length"] = String(payload.length);
      res.writeHead(status, headers);
      res.end(payload);
    };
    const rpcError = (status: number, code: number, message: string) =>
      send(status, { jsonrpc: "2.0", id: null, error: { code, message } });

    try {
      // DNS rebinding: only our own address.
      if (!allowedHosts().has(String(req.headers.host ?? "").toLowerCase())) {
        return rpcError(403, ERRORS.Forbidden, "unexpected Host header");
      }
      if (origin !== undefined) {
        if (!allowedOrigins.has(origin))
          return rpcError(403, ERRORS.Forbidden, `origin ${origin} isn't allowed`);
        cors["access-control-allow-origin"] = origin;
        cors.vary = "Origin";
      }
      if (req.method === "OPTIONS") {
        const preflight: Record<string, string> = {
          "access-control-allow-methods": "POST, PUT, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "600",
        };
        // Chrome's Local Network Access / Private Network Access preflight.
        if (req.headers["access-control-request-private-network"] === "true") {
          preflight["access-control-allow-private-network"] = "true";
        }
        res.writeHead(204, { ...cors, ...preflight });
        return res.end();
      }

      const auth = String(req.headers.authorization ?? "");
      const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
      if (!presented || !tokensEqual(presented, token)) {
        return rpcError(401, ERRORS.Unauthorized, "missing or invalid bearer token");
      }

      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/rpc") {
        if (req.method !== "POST") return rpcError(405, ERRORS.InvalidRequest, "POST only");
        const type = String(req.headers["content-type"] ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (type !== "application/json") {
          return rpcError(415, ERRORS.InvalidRequest, "Content-Type must be application/json");
        }
        const body = await readBody(req, MAX_RPC_BYTES);
        if (body === null) return rpcError(413, ERRORS.LimitExceeded, "request too large");
        const response = await handler(
          new Request("http://localhost/rpc", {
            method: "POST",
            body: body.toString("utf8"),
            headers: { "content-type": "application/json" },
          }),
        );
        return send(response.status, await response.text());
      }

      if (url.pathname.startsWith("/assets/")) {
        if (req.method !== "PUT") return rpcError(405, ERRORS.InvalidRequest, "PUT only");
        if (readOnly)
          return rpcError(403, ERRORS.ReadOnly, "this server is read-only: uploads are off");
        const type = String(req.headers["content-type"] ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const name = sanitizeAssetName(url.pathname.slice("/assets/".length));
        if (!name) return rpcError(400, ERRORS.InvalidParams, "invalid file name");
        const problem = uploadProblem(type, name);
        if (problem) return rpcError(415, ERRORS.InvalidRequest, problem);
        const declared = Number(req.headers["content-length"] ?? 0);
        if (declared > MAX_ASSET_BYTES)
          return rpcError(
            413,
            ERRORS.LimitExceeded,
            `files are limited to ${MAX_ASSET_BYTES} bytes`,
          );
        const body = await readBody(req, MAX_ASSET_BYTES);
        if (body === null)
          return rpcError(
            413,
            ERRORS.LimitExceeded,
            `files are limited to ${MAX_ASSET_BYTES} bytes`,
          );
        const written = writeAsset(assetsDir, name, body);
        reporter.info(`uploaded /assets/${written}`);
        return send(201, { path: `/assets/${written}` });
      }

      return rpcError(404, ERRORS.NotFound, "not found");
    } catch (error) {
      return rpcError(500, ERRORS.InternalError, (error as Error).message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new CliError(`port ${requestedPort} is in use; pass --port`)
          : error,
      ),
    );
    server.listen(requestedPort, host, () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  const displayHost = host.includes(":") ? `[${host}]` : host;
  const endpoint = `http://${displayHost}:${port}/rpc`;
  const connectUrl = `${studioOrigin(env)}/connect#endpoint=${encodeURIComponent(endpoint)}&token=${encodeURIComponent(token)}`;

  if (!LOOPBACK.has(host)) {
    reporter.warn(
      `warning: listening on ${host}: other machines can reach this server (the token still applies)`,
    );
  }
  const schemaFile = fs.existsSync(paths.schema)
    ? ".deco/schema.gen.json"
    : fs.existsSync(paths.legacySchema)
      ? ".deco/meta.gen.json"
      : "no schema: run deco schema";
  const count = storage.readBlocks().versions;
  const label = (name: string) => name.padEnd(21);
  reporter.info(`${label("Deco server")}${endpoint}`);
  reporter.info(
    `${label("Root")}${relativePosix(repoRoot, paths.root)}   (${schemaFile}, ${Object.keys(count).length} blocks)`,
  );
  reporter.info(
    readOnly
      ? `${label("Assets")}read-only: uploads are off`
      : `${label("Assets")}${relativePosix(repoRoot, assetsDir)}   (PUT /assets/<name>)`,
  );
  reporter.info(`${label("App preview")}${appUrl}`);
  reporter.info(`${label("Site editor")}${connectUrl}`);

  return {
    endpoint,
    token,
    connectUrl,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      if (!over) chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Write an upload without ever replacing a file: a taken name gets a short suffix. */
function writeAsset(dir: string, name: string, body: Uint8Array): string {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = attempt === 0 ? name : `${stem}-${randomBytes(3).toString("hex")}${ext}`;
    try {
      fs.writeFileSync(path.join(dir, candidate), body, { flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`couldn't find a free name for ${name}`);
}

/** `deco serve`: start, then run until interrupted. */
export async function serve(options: ServeOptions = {}): Promise<number> {
  const running = await startServer(options);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await running.close();
  return 0;
}
