/**
 * Test-only: the content protocol over the filesystem storage, served over
 * real HTTP (`/rpc` and `/assets/<name>`), so the content-protocol claims
 * still run black-box now that `deco serve` is gone. It is what `deco serve`
 * composed, without its banner, CORS or git checks: `createContentHandler`
 * and `createAssetHandler` over `createFsStorage`.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { ErrorCode } from "../../protocol/errors";
import { createAssetHandler } from "../../protocol/server/assets";
import { createContentHandler } from "../../protocol/server/index";
import { createFsStorage } from "../../protocol/storage/fs/index";
import { decoPaths, findDecoRoot, packageVersion } from "../cli/root";

export interface LocalServerOptions {
  cwd?: string;
  root?: string;
  readOnly?: boolean;
  /** The upload folder, relative to the app root. */
  assets?: string;
  /** The preview URL `describe` reports. */
  preview?: string;
}

export interface RunningServer {
  /** `http://127.0.0.1:<port>/rpc`. */
  endpoint: string;
  port: number;
  close(): Promise<void>;
}

function toRequest(req: IncomingMessage): Request {
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

export async function startLocalServer(options: LocalServerOptions = {}): Promise<RunningServer> {
  const paths = decoPaths(findDecoRoot(options));
  const storage = createFsStorage({
    root: paths.root,
    readOnly: options.readOnly ?? false,
    assetsDir: options.assets,
  });
  const rpc = createContentHandler(storage, {
    server: { name: "fs-test", version: packageVersion() },
    preview: { url: options.preview ?? "http://localhost:5173" },
  });
  const assets = createAssetHandler(storage);
  const server = createServer((req, res) => {
    void (async () => {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      const handler =
        pathname === "/rpc" ? rpc : pathname.startsWith("/assets/") ? assets : undefined;
      if (!handler) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: ErrorCode.NotFound, message: "not found" },
          }),
        );
        return;
      }
      const response = await handler(toRequest(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/rpc`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
