// @vitest-environment node
/**
 * Docs conformance, CLI side: releases-and-deployment (prebuild, revisions),
 * draft-synchronization (the fs storage, deco check), hosted-releases-internals
 * (the content module's identity) and hosted-site-editor (image fields). Runs
 * the real commands on temp fixture projects. `deco content` and `deco serve`
 * are gone: hosted content arrives at runtime, and the remote commands are
 * covered in ../cli/__tests__/remote.test.ts.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  checkProductionFromFolder,
  createFixture,
  type Fixture,
  recorder,
  STORE_FILES,
  startFolderCdn,
} from "../cli/__tests__/fixture";
import { checkContent } from "../cli/check/index";
import { type readSavedBlocks, writeContent } from "../cli/content";
import { decoPaths } from "../cli/root";
import { runCli } from "../cli/run";
import { type DecoMeta, generateSchema } from "../cli/schema/generate";

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

// deco check reads production from the CDN: here, the fixture's own blocks.
const run = (args: string[], cwd: string) =>
  runCli(args, { cwd, reporter: recorder(), ...checkProductionFromFolder(args, cwd) });

let cdn: Awaited<ReturnType<typeof startFolderCdn>>;
beforeAll(async () => {
  cdn = await startFolderCdn();
});
afterAll(() => cdn.close());

describe("releases-and-deployment", () => {
  it("RD-1: deco schema && deco check pass on fitting content; unfit content fails the build", async () => {
    fixture = createFixture({ ...STORE_FILES, ".deco/blocks/Home.json": home });
    expect(await run(["schema"], fixture.root)).toBe(0);
    expect(await run(["check"], fixture.root)).toBe(0);
    fixture.write(".deco/blocks/Home.json", {
      ...home,
      sections: [{ __resolveType: "hero", title: 42, size: "huge" }],
    });
    expect(await run(["check"], fixture.root)).not.toBe(0);
  }, 60_000);

  it("RD-1: the real deco bin runs `deco check` with exit codes; `deco content` is gone", () => {
    fixture = createFixture({ ".deco/blocks/Home.json": home });
    fixture.write(".deco/schema.gen.json", meta);
    const content = spawnSync(process.execPath, [BIN, "content"], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    expect(content.status).toBe(64);
    expect(content.stderr).toContain('unknown command "content"');
    const fits = spawnSync(process.execPath, [BIN, "check"], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, ...cdn.envFor(fixture.root) },
    });
    expect(fits.status, fits.stderr).toBe(0);
    fixture.write(".deco/blocks/Bad.json", { __resolveType: "no-such-type" });
    const check = spawnSync(process.execPath, [BIN, "check"], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, ...cdn.envFor(fixture.root) },
    });
    expect(check.status).not.toBe(0);
  }, 60_000);

  it("RD-3: the content module's revision hashes the whole map: same content, same revision; any edit, a new one", async () => {
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
  it("DS-2: the fs storage edits the working tree only: no GitHub calls, no commits; git writes only a discard's unstage", () => {
    const sources = [
      ...fs
        .readdirSync(path.join(HERE, "../../protocol/storage/fs"))
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => `../../protocol/storage/fs/${f}`),
    ];
    // Git calls that commit, move refs, rewrite the working tree, write
    // objects or talk to a remote. Never allowed, anywhere.
    const neverRun =
      /"(-w|commit|add|restore|checkout|switch|stash|push|fetch|pull|clone|remote|merge|rebase|write-tree|commit-tree|update-ref|tag|--hard|--soft|--keep|--merge)"/;
    // Index writes: allowed only inside `unstage`, which a discard runs on the
    // paths it restores, so a block staged with `git add`/`git mv`/`git rm`
    // isn't committed later (#689; covered by storage/fs/git.test.ts).
    const indexWrites = /"(reset|rm|update-index|read-tree|apply)"/;
    let unstageSeen = false;
    for (const file of sources) {
      const text = fs.readFileSync(path.join(HERE, file), "utf8");
      expect(text, file).not.toMatch(/api\.github|github\.com|simple-git|isomorphic-git/);
      if (!file.endsWith("/git.ts")) {
        // Only the base reader runs git.
        expect(text, file).not.toMatch(/child_process/);
        continue;
      }
      expect(text, file).not.toMatch(neverRun);
      const start = text.indexOf("async function unstage(");
      expect(start, `${file}: unstage`).toBeGreaterThan(-1);
      const end = text.indexOf("\n  }\n", start);
      expect(end, `${file}: end of unstage`).toBeGreaterThan(start);
      const unstage = text.slice(start, end);
      expect(text.slice(0, start) + text.slice(end), file).not.toMatch(indexWrites);
      // Inside unstage: `rm` only drops index entries (never the file), and
      // `reset` only resets named paths to HEAD.
      for (const call of unstage.match(/\[\s*"(rm|reset)"[^\]]*\]/g) ?? []) {
        if (call.includes('"rm"')) expect(call, file).toContain('"--cached"');
        else expect(call, file).toMatch(/^\[\s*"reset",\s*"-q",\s*"HEAD"\s*\]$/);
      }
      expect(unstage, file).toMatch(/forPaths\(top, \["reset"/);
      unstageSeen = true;
    }
    expect(unstageSeen).toBe(true);
  });

  it("DS-7: deco check reports route conflicts and broken references", async () => {
    fixture = createFixture({
      ".deco/blocks/A.json": home,
      ".deco/blocks/B.json": { ...home, name: "Also home" },
      ".deco/blocks/C.json": { ...home, path: "/c", sections: [{ __resolveType: "Missing" }] },
    });
    fixture.write(".deco/schema.gen.json", meta);
    const out = recorder();
    const code = await runCli(["check"], {
      cwd: fixture.root,
      reporter: out,
      ...checkProductionFromFolder(["check"], fixture.root),
    });
    expect(code).not.toBe(0);
    expect(out.text()).toContain("B.json");
    expect(out.text()).toContain("Missing");
  });
});

describe("hosted-site-editor", () => {
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
