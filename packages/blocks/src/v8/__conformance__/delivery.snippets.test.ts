// @vitest-environment node
/**
 * Docs conformance: the code examples on the hosted pages (hosted,
 * hosted-publishing, hosted-drafts) compile as written against the package's
 * types. Each snippet is copied verbatim from the docs into a throwaway
 * project (plus the declarations the docs leave to the reader: the app's own
 * `render`, `url`, `setClient`, the Workers `env`), type-checked once with
 * `tsc --strict`, and each test asserts its own file has no errors.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "../../../../..");
const PROJECT = path.join(WORKSPACE, "node_modules/.cache/deco-conformance/delivery-snippets");

const FILES: Record<string, string> = {
  ".deco/index.ts": `import type { Blocks, Seo } from "@decocms/blocks";
export default { seo: (input: Seo) => input } satisfies Blocks;
`,
  ".deco/blocks.gen.ts": `const content: {
  revision: string;
  schemaHash: string;
  blocks: Record<string, unknown>;
  aliases: Record<string, string>;
} = { revision: "r", schemaHash: "h", blocks: {}, aliases: {} };
export default content;
`,
  "env.d.ts": `declare module "cloudflare:workers" {
  // What \`wrangler types\` generates for a var and a secret.
  export const env: { DECO_SITE: string; DECO_SITE_TOKEN: string };
}
`,

  // H-2: hosted.mdx, "Connect your site".
  "hosted/cms.ts": `import { createCMS } from "@decocms/blocks";
import blocks from "../.deco";
import content from "../.deco/blocks.gen";

// Your app reads its own environment; the SDK reads none.
export const cms = createCMS({
  blocks,
  content,
  site: process.env.DECO_SITE,           // your site's ID: turns on hosted releases
  token: process.env.DECO_SITE_TOKEN,    // your site token (secret): turns on hosted telemetry
});
`,

  // H-8: hosted.mdx, "Cloudflare Workers".
  "workers/src/cms.ts": `import { createCMS } from "@decocms/blocks";
import { env } from "cloudflare:workers";
import blocks from "../../.deco";
import content from "../../.deco/blocks.gen";

export const cms = createCMS({
  blocks,
  content,
  site: env.DECO_SITE,
  token: env.DECO_SITE_TOKEN,   // optional: telemetry to the hosted collector
});
`,

  // HP-5: hosted-publishing.mdx, "Check interval".
  "publishing/interval.ts": `import { createCMS } from "@decocms/blocks";
import blocks from "../.deco";
import content from "../.deco/blocks.gen";

// Check for new releases every 2 minutes instead of every minute
createCMS({ blocks, content, site: process.env.DECO_SITE, interval: 120_000 });
`,

  // HP-16: hosted-publishing.mdx, "Troubleshooting".
  "publishing/troubleshooting.ts": `import { createCMS, remoteLoader } from "@decocms/blocks";
import blocks from "../.deco";
import content from "../.deco/blocks.gen";

const loader = remoteLoader(content, { site: process.env.DECO_SITE });
export const cms = createCMS({ blocks, content: loader });

// in a request handler or a debug route:
console.log((await loader.load()).revision);
`,

  // HD-7: hosted-drafts.mdx, "Wire drafts into your app" (a plain request handler).
  "drafts/handler.ts": `import type { Client } from "@decocms/blocks";
import { cms } from "../hosted/cms";
declare function render(client: Client, request: Request): Promise<Response>;

export async function handle(request: Request) {
  const pointer = await cms.draftPointer(request);     // from ?__draft= or the cookie; null on an ordinary request
  const client = pointer ? cms.forDraft(pointer) : cms.forRelease();
  const response = await render(client, request);      // your own function: list, matchRoute and resolve as usual

  const cookie = await cms.draftCookie(request);
  if (cookie) response.headers.append("Set-Cookie", cookie);
  return response;
}
`,

  // HD-9: hosted-drafts.mdx, Next.js proxy.ts.
  "next/src/proxy.ts": `import { NextResponse, type NextRequest } from "next/server";
import { cms } from "../../hosted/cms";

export async function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const cookie = await cms.draftCookie(request);   // only set on the request the site editor opens; expiring when leaving preview
  if (cookie) response.headers.append("Set-Cookie", cookie);
  return response;
}
`,

  // HD-10: hosted-drafts.mdx, Next.js client.server.ts.
  "next/src/client.server.ts": `import "server-only";
import { headers } from "next/headers";
import { cms } from "../../hosted/cms";

// The client for this request: a draft when the cookie holds a valid pointer on an allowed host, production otherwise.
export async function client() {
  const h = await headers();
  const pointer = await cms.draftPointer({ url: \`https://\${h.get("host")}/\`, headers: h });
  return pointer ? cms.forDraft(pointer) : cms.forRelease();
}
`,

  // HD-11: hosted-drafts.mdx, TanStack Start src/cms.ts (changes) and src/start.ts.
  "tanstack/src/cms.ts": `import { createCMS } from "@decocms/blocks";
import blocks from "../../.deco";
import content from "../../.deco/blocks.gen";

export const cms = createCMS({ blocks, content });

// The client for this request: the draft it points at, or the current release.
export const client = async (request: Request) => {
  const pointer = await cms.draftPointer(request);
  return pointer ? cms.forDraft(pointer) : cms.forRelease();
};
`,
  "tanstack/src/start.ts": `import { createMiddleware, createStart } from "@tanstack/react-start";
import { cms } from "./cms";

const draftCookieMiddleware = createMiddleware().server(async ({ request, next }) => {
  const result = await next();
  const cookie = await cms.draftCookie(request);   // only set on the request the site editor opens; expiring when leaving preview
  if (cookie) result.response.headers.append("Set-Cookie", cookie);
  return result;
});

export const startInstance = createStart(() => ({ requestMiddleware: [draftCookieMiddleware] }));
`,

  // HD-13: hosted-drafts.mdx, "Not a website" (React Native).
  "drafts/native.ts": `import type { Client } from "@decocms/blocks";
import { cms } from "../hosted/cms";
declare const url: string;
declare function setClient(client: Client): void;

// React Native, on a deep link like mystore://preview?__draft=...
const pointer = new URL(url).searchParams.get("__draft");
setClient(pointer ? cms.forDraft(pointer) : cms.forRelease());
`,

  // HD-18: hosted-drafts.mdx, "Who may preview" (narrowing previews further).
  "drafts/preview-host.ts": `import { cms } from "../hosted/cms";
declare function isEmployee(request: Request): boolean;
declare const request: Request;

const pointer = isEmployee(request) ? await cms.draftPointer(request) : null;   // isEmployee: your rule
export { pointer };
`,

  // DP-6: content-delivery.mdx, "Draft previews" (where draft pointers may point).
  "drafts/api-domains.ts": `import { createCMS } from "@decocms/blocks";
import blocks from "../.deco";
import content from "../.deco/blocks.gen";

export const cms = createCMS({
  blocks,
  content,
  preview: { apiDomains: [".decocms.com", "drafts.example.com"] },   // replaces the defaults
});
`,

  // RD-11: releases-and-drafts.mdx, "Allow previews per host" (code caps the list).
  "drafts/preview-cap.ts": `import { createCMS } from "@decocms/blocks";
import blocks from "../.deco";
import content from "../.deco/blocks.gen";

export const cms = createCMS({
  blocks,
  content,
  preview: { hosts: ["*.example.com", "localhost:3000"] },   // the most content may allow
});
`,
};

let errors: { file: string; message: string }[] = [];
let output = "";

beforeAll(() => {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  for (const [file, text] of Object.entries(FILES)) {
    const full = path.join(PROJECT, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  fs.writeFileSync(
    path.join(PROJECT, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: ["node"],
        jsx: "react-jsx",
        skipLibCheck: true,
        resolveJsonModule: true,
        allowImportingTsExtensions: true,
      },
      files: Object.keys(FILES),
    }),
  );
  const tsc = path.join(WORKSPACE, "node_modules/typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", PROJECT, "--pretty", "false"], {
    cwd: PROJECT,
    encoding: "utf8",
  });
  output = `${result.stdout}${result.stderr}`;
  errors = output
    .split("\n")
    .map((line) => /^(.+?)\(\d+,\d+\): error (TS\d+: .*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ file: path.relative(PROJECT, path.resolve(PROJECT, m[1]!)), message: m[2]! }));
}, 180_000);

const errorsIn = (file: string) => errors.filter((e) => e.file === file).map((e) => e.message);

describe("hosted docs examples compile", () => {
  it.each([
    ["H-2", "hosted/cms.ts"],
    ["H-8", "workers/src/cms.ts"],
    ["HP-5", "publishing/interval.ts"],
    ["HP-16", "publishing/troubleshooting.ts"],
    ["HD-7", "drafts/handler.ts"],
    ["HD-9", "next/src/proxy.ts"],
    ["HD-10", "next/src/client.server.ts"],
    ["HD-11", "tanstack/src/cms.ts"],
    ["HD-11", "tanstack/src/start.ts"],
    ["HD-13", "drafts/native.ts"],
    ["HD-18", "drafts/preview-host.ts"],
    ["RD-11", "drafts/preview-cap.ts"],
    ["DP-6", "drafts/api-domains.ts"],
  ])("%s: %s", (_claim, file) => {
    expect(errorsIn(file)).toEqual([]);
  });
});
