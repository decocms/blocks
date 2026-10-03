/**
 * `deco serve`: the local server the site editor uses to edit the files on
 * this machine (spec: cli › deco serve; content-protocol › The local server).
 *
 * The content protocol is `@decocms/blocks/protocol`'s `createContentHandler`
 * (at `/rpc`) and `createAssetHandler` (at `/assets/<name>`) over the
 * filesystem storage; they own the bearer token, `Content-Type`, size limits
 * and upload rules. This file is the Node HTTP layer and the checks that
 * depend on where it runs:
 *
 * - Listens on 127.0.0.1 unless `--host` says otherwise (with a warning).
 * - Browser requests are accepted only from the site editor's origins and
 *   `--allow-origin`; CORS and Chrome's local-network preflights are answered.
 * - Any `Host` other than the server's own address is refused (DNS rebinding).
 * - Every save regenerates `.deco/blocks.gen.ts`.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { ErrorCode } from "../../../protocol/errors";
import { blockNameFromFile } from "../../../protocol/keys";
import { createContentHandler } from "../../../protocol/server";
import { createAssetHandler } from "../../../protocol/server/assets";
import type { ContentStorage } from "../../../protocol/storage";
import { createFsStorage } from "../../../protocol/storage/fs";
import { readSavedBlocks, writeContent } from "../content";
import { consoleReporter, type Reporter } from "../log";
import { CliError, decoPaths, findDecoRoot } from "../root";

/** The site editor's origins: the browser origins allowed by default. */
const STUDIO_ORIGINS = [
  "https://studio.decocms.com",
  "https://admin.decocms.com",
  "https://admin.deco.cx",
];

/** Where the connect link points. */
const STUDIO_ORIGIN = STUDIO_ORIGINS[0];

const DEFAULT_PORT = 4545;
const DEFAULT_HOST = "127.0.0.1";

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

/** The dev app the canvas opens when `--app-url` isn't given and no Vite port is set. */
export const DEFAULT_APP_URL = "http://localhost:5173";

const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];

/**
 * `http://localhost:<server.port>` from the app's Vite config, read as text
 * (the config is never executed), or `DEFAULT_APP_URL`.
 */
function defaultAppUrl(root: string): string {
  for (const name of VITE_CONFIGS) {
    let source: string;
    try {
      source = fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    const port = /\bserver\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})\b/.exec(source)?.[1];
    return port ? `http://localhost:${port}` : DEFAULT_APP_URL;
  }
  return DEFAULT_APP_URL;
}

function packageVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"))
      .version;
  } catch {
    return "0.0.0";
  }
}

/** Start the server; resolves once it listens. */
export async function startServer(options: ServeOptions = {}): Promise<RunningServer> {
  const reporter = options.reporter ?? consoleReporter;
  const env = options.env ?? process.env;
  const paths = decoPaths(findDecoRoot(options));
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
  const appUrl = options.appUrl ?? defaultAppUrl(paths.root);
  const allowedOrigins = new Set(
    [...STUDIO_ORIGINS, ...(options.allowOrigins ?? [])].map((o) => o.replace(/\/+$/, "")),
  );

  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new CliError(`--port must be a port number, got ${requestedPort}`);
  }
  try {
    new URL(appUrl);
  } catch {
    throw new CliError(`--app-url must be a URL, got ${appUrl}`);
  }

  const fsStorage = createFsStorage({ root: paths.root, readOnly, assetsDir: options.assets });
  const storage: ContentStorage = {
    ...fsStorage,
    async commit(attempt) {
      const result = await fsStorage.commit(attempt);
      if (result.status !== "committed") return result;
      const names = [...Object.keys(attempt.put), ...attempt.delete].map(blockNameFromFile);
      reporter.info(
        `saved ${names.length} block${names.length === 1 ? "" : "s"}: ${names.join(", ")}`,
      );
      // Every save changes the content, so the content module's revision
      // changes too (a revision is never reused for different content). An
      // unchanged module isn't rewritten, so this costs nothing when it isn't.
      try {
        await writeContent(paths);
      } catch (error) {
        reporter.warn(`couldn't regenerate .deco/blocks.gen.ts: ${(error as Error).message}`);
      }
      return result;
    },
    async putAsset(name, body) {
      const stored = await fsStorage.putAsset!(name, body);
      reporter.info(`uploaded /assets/${stored.name}`);
      return stored;
    },
  };
  const rpc = createContentHandler(storage, {
    token,
    server: { name: "deco-cli", version: packageVersion() },
    preview: { origin: new URL(appUrl).origin },
    onError: (error) => reporter.warn(String((error as Error)?.message ?? error)),
  });
  const assets = createAssetHandler(storage, { token });

  let port = requestedPort;
  const allowedHosts = () => {
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!LOOPBACK.has(host)) hosts.add(`${host.includes(":") ? `[${host}]` : host}:${port}`);
    return hosts;
  };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> = {};
    const refuse = (status: number, code: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
    };

    try {
      // DNS rebinding: only our own address.
      if (!allowedHosts().has(String(req.headers.host ?? "").toLowerCase())) {
        return refuse(403, ErrorCode.Forbidden, "unexpected Host header");
      }
      if (origin !== undefined) {
        if (!allowedOrigins.has(origin)) {
          return refuse(403, ErrorCode.Forbidden, `origin ${origin} isn't allowed`);
        }
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

      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      const handler =
        pathname === "/rpc" ? rpc : pathname.startsWith("/assets/") ? assets : undefined;
      if (!handler) return refuse(404, ErrorCode.NotFound, "not found");
      const response = await handler(toRequest(req));
      const headers = Object.fromEntries(response.headers);
      res.writeHead(response.status, { ...headers, "cache-control": "no-store", ...cors });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      refuse(500, ErrorCode.InternalError, (error as Error).message);
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
  const connectUrl = `${STUDIO_ORIGIN}/connect#endpoint=${encodeURIComponent(endpoint)}&token=${encodeURIComponent(token)}`;

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
  const count = Object.keys(readSavedBlocks(paths.blocks).blocks).length;
  const description = await storage.describe();
  const label = (name: string) => name.padEnd(21);
  reporter.info(`${label("Deco server")}${endpoint}`);
  reporter.info(`${label("Root")}${description.root}   (${schemaFile}, ${count} blocks)`);
  reporter.info(
    description.assets
      ? `${label("Assets")}${description.assets.dir}   (PUT /assets/<name>)`
      : `${label("Assets")}read-only: uploads are off`,
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

/** A Node request as a fetch `Request`, its body streamed. */
function toRequest(req: http.IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", "http://localhost"), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: "half",
  } as RequestInit);
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
