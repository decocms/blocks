// @vitest-environment node
/**
 * Docs conformance, Workers binding: hosted.mdx ("Release checks on Workers
 * run after the response, inside ctx.waitUntil, on their own"),
 * hosted-releases-internals.mdx (idle scheduling on Workers) and
 * hosted-publishing.mdx ("Large content on Workers": kvLoader as `content`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCMS, resetForTests } from "@decocms/blocks";
import { computeContentRevision } from "@decocms/blocks/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kvLoader } from "../kvLoader";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, "../../../../..");
const ORIGIN = "https://delivery.decocms.com";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetForTests();
});

const seo = (props: { title: string; description: string }) => props;

describe("hosted-publishing: large content on Workers", () => {
  it("HP-14: kvLoader as content; a missing key fails reads until the first release check", async () => {
    const blocks = { SummerSEO: { __resolveType: "seo", title: "Released", description: "d" } };
    const revision = await computeContentRevision(blocks);
    const asset = `/sites/acme/revisions/${revision}.json`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === `${ORIGIN}/sites/acme/channels/production.json`) {
          return Response.json({ format: 1, generation: 1, revision, snapshot: asset });
        }
        if (url === `${ORIGIN}${asset}`) return Response.json({ revision, blocks });
        return new Response("not found", { status: 404 });
      }),
    );
    const namespace = { get: vi.fn(async () => null) }; // the deploy didn't write the key
    const cms = createCMS({
      blocks: { seo },
      content: kvLoader(namespace, { key: "decofile:abc" }),
      site: "acme",
      token: "t",
    });
    const [, error] = await cms.forRelease().resolve("SummerSEO");
    expect(error?.code).toBe("LOADER_FAILED");
    expect(await cms.update()).toEqual({ updated: true });
    const [value, after] = await cms.forRelease().resolve<{ title: string }>("SummerSEO");
    expect(after).toBeNull();
    expect(value?.title).toBe("Released");
  });
});

describe("hosted: release checks on Workers", () => {
  it("H-10/HRI-4: the documented Workers setup runs due checks inside ctx.waitUntil, with no user code", () => {
    // The documented TanStack Start setup (tanstack-start-descriptors.mdx,
    // examples/tanstack-smoke) runs Start's own server entry:
    const wrangler = fs.readFileSync(
      path.join(WORKSPACE, "examples/tanstack-smoke/wrangler.jsonc"),
      "utf8",
    );
    expect(wrangler).toContain('"main": "@tanstack/react-start/server-entry"');
    // So something in the next-major surface (core or binding) must route the
    // core's background work into ctx.waitUntil on its own: install the
    // `Symbol.for("decocms.blocks.background")` hook, or use Workers'
    // `waitUntil` from "cloudflare:workers". Today only the v7
    // `createDecoWorkerEntry` (sdk/workerEntry.ts) installs that hook, and the
    // documented setup never runs it, so checks fall back to a timer.
    const roots = [
      path.join(WORKSPACE, "packages/blocks/src/v8"),
      path.join(WORKSPACE, "packages/tanstack/src/v8"),
    ];
    const installers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__conformance__") walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (
            /installBackgroundHook|from "cloudflare:workers"|\[(BACKGROUND_HOOK|HOOK)\]\s*=(?!=)/.test(
              text,
            )
          ) {
            installers.push(path.relative(WORKSPACE, full));
          }
        }
      }
    };
    for (const dir of roots) walk(dir);
    expect(installers).not.toEqual([]);
  });
});
