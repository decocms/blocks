// @vitest-environment node
/**
 * Docs conformance, CLI side: releases-and-deployment (prebuild, revisions),
 * draft-synchronization (deco serve, ifMatch, polling, deco check),
 * hosted-releases-internals (the content module's identity) and
 * hosted-site-editor (deco serve's root, uploads and polling). Runs the real
 * commands on temp fixture projects.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createContentClient } from "../../protocol/client";
import { ContentProtocolError, ErrorCode } from "../../protocol/errors";
import { createFixture, type Fixture, recorder, STORE_FILES } from "../cli/__tests__/fixture";
import { checkContent } from "../cli/check/index";
import { type readSavedBlocks, writeContent } from "../cli/content";
import { decoPaths } from "../cli/root";
import { parseFlags, runCli } from "../cli/run";
import { type DecoMeta, generateSchema } from "../cli/schema/generate";
import { startServer } from "../cli/serve/server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "../../../bin/deco.js");

const hero = { __resolveType: "hero", title: "Summer", size: "md" };
const home = { __resolveType: "page", name: "Home", path: "/", sections: [hero] };

let meta: DecoMeta;
beforeAll(async () => {
  const f = createFixture(STORE_FILES);
  try {
    ({ meta } = await generateSchema(decoPaths(f.root)));
  } finally {
    f.remove();
  }
}, 60_000);

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.remove();
  fixture = undefined;
});

const run = (args: string[], cwd: string) => runCli(args, { cwd, reporter: recorder() });

describe("releases-and-deployment", () => {
  it("RD-1: prebuild (deco schema && deco content && deco check) writes the content module; unfit content fails the build", async () => {
    fixture = createFixture({ ...STORE_FILES, ".deco/blocks/Home.json": home });
    expect(await run(["schema"], fixture.root)).toBe(0);
    expect(await run(["content"], fixture.root)).toBe(0);
    expect(fixture.exists(".deco/blocks.gen.ts")).toBe(true);
    expect(await run(["check"], fixture.root)).toBe(0);
    fixture.write(".deco/blocks/Home.json", {
      ...home,
      sections: [{ __resolveType: "hero", title: 42, size: "huge" }],
    });
    expect(await run(["check"], fixture.root)).not.toBe(0);
  }, 60_000);

  it("RD-1: the real deco bin runs `deco content` and `deco check` with exit codes", () => {
    fixture = createFixture({ ".deco/blocks/Home.json": home });
    fixture.write(".deco/schema.gen.json", meta);
    const content = spawnSync(process.execPath, [BIN, "content"], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    expect(content.status, content.stderr).toBe(0);
    expect(fixture.read(".deco/blocks.gen.ts")).toContain('"Home"');
    fixture.write(".deco/blocks/Bad.json", { __resolveType: "no-such-type" });
    const check = spawnSync(process.execPath, [BIN, "check"], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    expect(check.status).not.toBe(0);
  }, 60_000);

  it("RD-3: deco content's revision hashes the whole map: same content, same revision; any edit, a new one", async () => {
    const a = createFixture();
    const b = createFixture();
    try {
      a.write(".deco/blocks/A.json", { __resolveType: "seo", title: "a", description: "d" });
      a.write(".deco/blocks/B.json", { description: "d", title: "b", __resolveType: "seo" });
      // Written in the other order, keys in another order.
      b.write(".deco/blocks/B.json", { __resolveType: "seo", title: "b", description: "d" });
      b.write(".deco/blocks/A.json", { title: "a", description: "d", __resolveType: "seo" });
      const ra = (await writeContent(decoPaths(a.root))).revision;
      const rb = (await writeContent(decoPaths(b.root))).revision;
      expect(ra).toBe(rb);
      expect((await writeContent(decoPaths(a.root))).revision).toBe(ra);
      b.write(".deco/blocks/B.json", { __resolveType: "seo", title: "b!", description: "d" });
      expect((await writeContent(decoPaths(b.root))).revision).not.toBe(ra);
      expect(b.read(".deco/blocks.gen.ts")).toContain(
        `revision: ${JSON.stringify((await writeContent(decoPaths(b.root))).revision)}`,
      );
    } finally {
      a.remove();
      b.remove();
    }
  });
});

describe("hosted-releases-internals", () => {
  it("HRI-12: the content module names the .deco folder it was generated from (its instance identity)", async () => {
    fixture = createFixture({ ".deco/blocks/Home.json": home });
    await writeContent(decoPaths(fixture.root));
    // createCMS keys the content module on `root`; without it, a hot-reloaded
    // module object gets a new instance instead of keeping the old one.
    expect(fixture.read(".deco/blocks.gen.ts")).toMatch(/\broot:\s*"[^"]*\.deco"/);
  });
});

describe("draft-synchronization", () => {
  it("DS-2: deco serve edits the working tree only: no git or GitHub calls", () => {
    const sources = [
      "../cli/serve/server.ts",
      ...fs
        .readdirSync(path.join(HERE, "../../protocol/storage/fs"))
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => `../../protocol/storage/fs/${f}`),
    ];
    for (const file of sources) {
      const text = fs.readFileSync(path.join(HERE, file), "utf8");
      expect(text, file).not.toMatch(
        /child_process|api\.github|github\.com|simple-git|isomorphic-git/,
      );
    }
  });

  describe("against a running deco serve", () => {
    let site: Fixture;
    let server: Awaited<ReturnType<typeof startServer>>;
    const TOKEN = "conformance-token";
    beforeAll(async () => {
      site = createFixture({ ".deco/blocks/Hero.json": hero });
      site.write(".deco/schema.gen.json", meta);
      fs.mkdirSync(path.join(site.root, "apps"), { recursive: true });
      server = await startServer({
        cwd: site.root,
        port: 0,
        token: TOKEN,
        reporter: recorder(),
        env: {},
      });
    });
    afterAll(async () => {
      await server?.close();
      site?.remove();
    });
    const client = () => createContentClient({ endpoint: server.endpoint, token: TOKEN });

    it("DS-5: a save with a stale ifMatch is a Conflict; without ifMatch the last writer wins", async () => {
      const listed = await client().blocksList();
      if (listed.notModified) throw new Error("unexpected notModified");
      const stale = listed.versions.Hero!;
      await client().blocksApply({ set: { Hero: { ...hero, title: "Other editor" } } });
      const error = await client()
        .blocksApply({ set: { Hero: { ...hero, title: "Mine" } }, ifMatch: { Hero: stale } })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ContentProtocolError);
      expect((error as ContentProtocolError).code).toBe(ErrorCode.Conflict);
      await client().blocksApply({ set: { Hero: { ...hero, title: "Last writer" } } });
      expect(JSON.parse(site.read(".deco/blocks/Hero.json")).title).toBe("Last writer");
    });

    it("DS-6/HSE-2: the protocol is polling-based: plain reads see changes; local poll ~2 s", async () => {
      const description = await client().describe();
      expect(description.pollIntervalMs).toBe(2000);
      const before = await client().blocksList();
      site.write(".deco/blocks/Hero.json", { ...hero, title: "Edited on disk" });
      const after = await client().blocksList();
      if (after.notModified || before.notModified) throw new Error("unexpected notModified");
      expect(after.revision).not.toBe(before.revision);
      expect(after.blocks.Hero?.title).toBe("Edited on disk");
    });

    it("HSE-1: uploads default to public/assets", async () => {
      const description = await client().describe();
      expect(description.assets?.dir).toBe("public/assets");
    });
  });

  it("DS-7: deco check reports route conflicts and broken references", async () => {
    fixture = createFixture({
      ".deco/blocks/A.json": home,
      ".deco/blocks/B.json": { ...home, name: "Also home" },
      ".deco/blocks/C.json": { ...home, path: "/c", sections: [{ __resolveType: "Missing" }] },
    });
    fixture.write(".deco/schema.gen.json", meta);
    const out = recorder();
    const code = await runCli(["check"], { cwd: fixture.root, reporter: out });
    expect(code).not.toBe(0);
    expect(out.text()).toContain("B.json");
    expect(out.text()).toContain("Missing");
  });
});

describe("hosted-site-editor", () => {
  it("HSE-1: deco serve finds .deco from a subfolder, or takes --root; --assets moves uploads", async () => {
    expect(parseFlags("serve", ["--root", "apps/web", "--assets", "static/uploads"])).toEqual({
      root: "apps/web",
      assets: "static/uploads",
    });
    fixture = createFixture({ ".deco/blocks/Hero.json": hero });
    fixture.write(".deco/schema.gen.json", meta);
    fs.mkdirSync(path.join(fixture.root, "src", "deep"), { recursive: true });
    const TOKEN = "t";
    for (const options of [
      { cwd: path.join(fixture.root, "src", "deep") },
      { cwd: "/", root: fixture.root, assets: "static/uploads" },
    ]) {
      const server = await startServer({
        port: 0,
        token: TOKEN,
        reporter: recorder(),
        env: {},
        ...options,
      });
      try {
        const c = createContentClient({ endpoint: server.endpoint, token: TOKEN });
        const listed = await c.blocksList();
        expect(listed.notModified ? null : Object.keys(listed.blocks)).toEqual(["Hero"]);
        const d = await c.describe();
        expect(d.assets?.dir).toBe("assets" in options ? "static/uploads" : "public/assets");
      } finally {
        await server.close();
      }
    }
  });

  it("HSE-4: an image field holds either a CDN URL or a repository-relative upload path", () => {
    for (const image of [
      "https://assets.decocms.com/acme/summer-banner.jpg",
      "/assets/summer-banner.jpg",
    ]) {
      const saved = {
        blocks: { Hero: { ...hero, image } },
        files: { Hero: "Hero.json" },
        diagnostics: [],
      };
      expect(checkContent(meta, saved as ReturnType<typeof readSavedBlocks>)).toEqual([]);
    }
  });
});
