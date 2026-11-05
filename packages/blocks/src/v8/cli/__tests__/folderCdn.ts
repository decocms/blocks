/**
 * Test-only, run with tsx by `startFolderCdn()` (fixture.ts): a CDN in its
 * own process, so a `deco` spawned with `spawnSync` can reach it. The first
 * path segment is a fixture root (base64url); the rest is the CDN key, and
 * that folder's `.deco/blocks` is production (`folderAnswer`). Prints its
 * port on the first line of stdout.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { folderAnswer } from "./fixture";

const server = createServer((req, res) => {
  const [, encoded = "", ...key] = (req.url ?? "").split("?", 1)[0]!.split("/");
  const answer = folderAnswer(`/${key.join("/")}`, Buffer.from(encoded, "base64url").toString());
  res.writeHead(answer.status, { "content-type": "application/json" });
  res.end(JSON.stringify(answer.body));
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${(server.address() as AddressInfo).port}\n`);
});
