/**
 * Test helper: serves a fetch handler over real HTTP with node:http, so the
 * conformance suite runs black-box over the network like it does against
 * `deco serve` or the site editor's backend.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: "half",
  } as RequestInit);
}

async function send(response: Response, res: ServerResponse) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>)
      res.write(chunk);
  }
  res.end();
}

export async function serve(handler: (request: Request) => Promise<Response>) {
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
    handler(toRequest(req, origin))
      .then((response) => send(response, res))
      .catch((error) => {
        res.statusCode = 500;
        res.end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
