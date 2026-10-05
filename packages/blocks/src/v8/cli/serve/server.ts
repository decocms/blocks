/**
 * `deco serve`: the local server the site editor uses to edit the files on
 * this machine (spec: cli › deco serve; content-protocol › The local server).
 *
 * The content protocol is `@decocms/blocks/protocol`'s `createContentHandler`
 * (at `/rpc`) and `createAssetHandler` (at `/assets/<name>`) over the
 * filesystem storage; they own `Content-Type`, size limits and upload rules.
 * `deco serve` has no authentication and answers any origin: any website open
 * in the browser can read and write the content through it, so it is meant
 * to run only while editing. This file is the Node HTTP layer:
 *
 * - Listens on 127.0.0.1 unless `--host` says otherwise (with a warning:
 *   the network can reach it then).
 * - CORS is answered for any `Origin` (reflected, with `Vary: Origin`), and
 *   so are Chrome's Private/Local Network Access preflights.
 * - Every save regenerates `.deco/blocks.gen.ts`.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { ErrorCode } from "../../../protocol/errors.ts";
import { blockNameFromFile } from "../../../protocol/keys.ts";
import { createAssetHandler } from "../../../protocol/server/assets.ts";
import { createContentHandler } from "../../../protocol/server/index.ts";
import { createFsStorage } from "../../../protocol/storage/fs/index.ts";
import type { ContentStorage } from "../../../protocol/storage.ts";
import { readSavedBlocks, writeContent } from "../content.ts";
import { consoleReporter, type Reporter } from "../log.ts";
import { CliError, decoPaths, findDecoRoot, packageVersion } from "../root.ts";

/** Where the site editor link points. */
const STUDIO_ORIGIN = "https://studio.decocms.com";

const DEFAULT_PORT = 4545;
const DEFAULT_HOST = "127.0.0.1";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface ServeOptions {
  root?: string;
  cwd?: string;
  port?: number;
  host?: string;
  /** The local app the site editor previews: `localhost:8001` or a full loopback URL. */
  preview?: string;
  /** The upload folder, relative to the folder that contains `.deco`. */
  assets?: string;
  readOnly?: boolean;
  reporter?: Reporter;
}

export interface RunningServer {
  /** The content protocol endpoint, `http://127.0.0.1:4545/rpc`. */
  endpoint: string;
  siteEditorUrl: string;
  port: number;
  close(): Promise<void>;
}

/** The app the site editor previews when `--preview` isn't given and no Vite port is set. */
export const DEFAULT_PREVIEW_URL = "http://localhost:5173";

const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];

/**
 * `http://localhost:<server.port>` from the app's Vite config, read as text
 * (the config is never executed), or `DEFAULT_PREVIEW_URL`.
 */
function defaultPreviewUrl(root: string): string {
  for (const name of VITE_CONFIGS) {
    let source: string;
    try {
      source = fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    const port = /\bserver\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})\b/.exec(source)?.[1];
    return port ? `http://localhost:${port}` : DEFAULT_PREVIEW_URL;
  }
  return DEFAULT_PREVIEW_URL;
}

/**
 * `--preview` as a URL: a bare `host:port` gets `http://`; only http(s) on a
 * loopback host, since the site editor loads it in an iframe.
 */
function previewUrl(input: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  const url = URL.canParse(withScheme) ? new URL(withScheme) : null;
  if (!url || !/^https?:$/.test(url.protocol) || !LOOPBACK.has(url.hostname)) {
    throw new CliError(
      `--preview must be a local address such as localhost:5173 or http://127.0.0.1:3000, got ${input}`,
    );
  }
  return url.pathname === "/" && !url.search && !url.hash ? url.origin : url.href;
}

/** Start the server; resolves once it listens. */
export async function startServer(options: ServeOptions = {}): Promise<RunningServer> {
  const reporter = options.reporter ?? consoleReporter;
  const paths = decoPaths(findDecoRoot(options));
  const host = (options.host ?? DEFAULT_HOST).toLowerCase();
  const requestedPort = options.port ?? DEFAULT_PORT;
  const readOnly = options.readOnly ?? false;
  const preview = previewUrl(options.preview ?? defaultPreviewUrl(paths.root));

  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new CliError(`--port must be a port number, got ${requestedPort}`);
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
    server: { name: "deco-cli", version: packageVersion() },
    preview: { url: preview },
    onError: (error) => reporter.warn(String((error as Error)?.message ?? error)),
  });
  const assets = createAssetHandler(storage);

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> = {};
    const refuse = (status: number, code: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
    };

    try {
      if (origin !== undefined) {
        cors["access-control-allow-origin"] = origin;
        cors.vary = "Origin";
      }
      if (req.method === "OPTIONS") {
        const preflight: Record<string, string> = {
          "access-control-allow-methods": "POST, PUT, OPTIONS",
          "access-control-allow-headers": "content-type",
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
  const port = (server.address() as AddressInfo).port;

  const displayHost = host.includes(":") ? `[${host}]` : host;
  const endpoint = `http://${displayHost}:${port}/rpc`;
  // The site editor connects only through loopback; a wildcard address
  // listens there too, so its link uses 127.0.0.1.
  const wildcard = host === "0.0.0.0" || host === "::";
  const linkEndpoint = wildcard ? `http://127.0.0.1:${port}/rpc` : endpoint;
  const siteEditorUrl = `${STUDIO_ORIGIN}/site-editor#endpoint=${encodeURIComponent(linkEndpoint)}`;

  if (!LOOPBACK.has(host)) {
    reporter.warn(
      `warning: listening on ${host}: other machines on the network can reach this server and read and write the content` +
        (wildcard ? "" : "; the site editor connects only through 127.0.0.1/localhost"),
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
  reporter.info(`${label("Preview")}${preview}`);
  reporter.info(`${label("Site editor")}${siteEditorUrl}`);

  return {
    endpoint,
    siteEditorUrl,
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
