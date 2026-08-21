import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DENY,
  fetchDecofile,
  findPlaintextSecrets,
  hasEncryptedSecretRef,
  matchesGlob,
  writeDecofileToDir,
} from "./pull-decofile";

function tmpBlocksDir(files: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pull-decofile-"));
  const out = path.join(dir, ".deco", "blocks");
  fs.mkdirSync(out, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(out, file), `${JSON.stringify(content, null, 2)}\n`);
  }
  return out;
}

const ls = (dir: string) => fs.readdirSync(dir).sort();
const read = (dir: string, file: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as Record<string, unknown>;

describe("matchesGlob", () => {
  it("matches whole keys with a * wildcard", () => {
    expect(matchesGlob("Site", "Site")).toBe(true);
    expect(matchesGlob("Sitemap", "Site")).toBe(false);
    expect(matchesGlob("pages-Home", "pages-*")).toBe(true);
    expect(matchesGlob("deco-vtex", "deco-*")).toBe(true);
    // dots are literal, not "any char"
    expect(matchesGlob("axb", "a.b")).toBe(false);
  });
});

describe("hasEncryptedSecretRef", () => {
  it("finds a {name, encrypted} ref at any depth", () => {
    expect(hasEncryptedSecretRef({ appKey: { name: "BANANA", encrypted: "3a714de1" } })).toBe(true);
    expect(hasEncryptedSecretRef({ a: [{ b: { name: "X", encrypted: "y" } }] })).toBe(true);
    expect(hasEncryptedSecretRef({ name: "X", encrypted: "" })).toBe(false);
    expect(hasEncryptedSecretRef({ sections: [{ __resolveType: "site/x.tsx" }] })).toBe(false);
  });
});

describe("findPlaintextSecrets", () => {
  it("flags credential-shaped props holding a raw string", () => {
    expect(findPlaintextSecrets({ appToken: "abcdefghijklmnop" })).toEqual(["appToken"]);
    expect(findPlaintextSecrets({ nested: { api_key: "abcdefghijklmnop" } })).toEqual([
      "nested.api_key",
    ]);
    expect(findPlaintextSecrets({ list: [{ password: "abcdefghijklmnop" }] })).toEqual([
      "list[0].password",
    ]);
  });

  it("ignores a bare `key` prop — CMS content is full of them", () => {
    // real shape: every VTEX PLP loader block carries selectedFacets[].key
    expect(
      findPlaintextSecrets({ selectedFacets: [{ key: "productClusterIds", value: "140" }] }),
    ).toEqual([]);
    // …but a qualified key still counts
    expect(findPlaintextSecrets({ apiKey: "abcdefghijklmnop" })).toEqual(["apiKey"]);
    expect(findPlaintextSecrets({ "private-key": "abcdefghijklmnop" })).toEqual(["private-key"]);
  });

  it("does not flag encrypted refs, urls, prose or short values", () => {
    expect(findPlaintextSecrets({ appKey: { name: "X", encrypted: "abcdefghijklmnop" } })).toEqual(
      [],
    );
    expect(findPlaintextSecrets({ tokenUrl: "https://x.com/very/long/path" })).toEqual([]);
    expect(findPlaintextSecrets({ secret: "short" })).toEqual([]);
    expect(findPlaintextSecrets({ password: "uma frase com espacos" })).toEqual([]);
    expect(findPlaintextSecrets({ apiKey: "{{ FROM_ENV_VAR_HERE }}" })).toEqual([]);
  });
});

describe("writeDecofileToDir", () => {
  it("writes one single-encoded file per block and skips unchanged ones", () => {
    const out = tmpBlocksDir();
    const remote = {
      "pages-Home": { name: "Home", path: "/", sections: [] },
      "pages-A B": { name: "A B", path: "/a-b", sections: [] },
    };

    const first = writeDecofileToDir(remote, { out });
    expect(first.added.sort()).toEqual(["pages-A B", "pages-Home"]);
    expect(ls(out)).toEqual(["pages-A%20B.json", "pages-Home.json"]);
    expect(read(out, "pages-Home.json").path).toBe("/");

    const second = writeDecofileToDir(remote, { out });
    expect(second.unchanged).toBe(2);
    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
  });

  it("compares content, not bytes — minified or reordered locals are not churn", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pull-decofile-"));
    const out = path.join(dir, "blocks");
    fs.mkdirSync(out, { recursive: true });
    // how the Studio daemon / old sync bot write it: one minified line, no newline
    fs.writeFileSync(path.join(out, "pages-Home.json"), '{"sections":[],"path":"/","name":"Home"}');

    const report = writeDecofileToDir(
      { "pages-Home": { name: "Home", path: "/", sections: [] } },
      { out },
    );
    expect(report.unchanged).toBe(1);
    expect(report.updated).toEqual([]);
    // untouched: no reformat commit
    expect(fs.readFileSync(path.join(out, "pages-Home.json"), "utf-8")).toBe(
      '{"sections":[],"path":"/","name":"Home"}',
    );

    // a real content change does get written, pretty-printed
    const changed = writeDecofileToDir({ "pages-Home": { name: "Home v2", path: "/" } }, { out });
    expect(changed.updated).toEqual(["pages-Home"]);
    expect(fs.readFileSync(path.join(out, "pages-Home.json"), "utf-8")).toContain('\n  "name"');
  });

  it("denies keys by glob, defaulting to the Site block", () => {
    const out = tmpBlocksDir({ "Site.json": { seo: { title: "local" } } });
    const report = writeDecofileToDir(
      { Site: { seo: { title: "prod" } }, "pages-Home": { path: "/" } },
      { out },
    );
    expect(DEFAULT_DENY).toContain("Site");
    expect(report.denied).toEqual(["Site"]);
    expect(read(out, "Site.json").seo).toEqual({ title: "local" });

    const custom = writeDecofileToDir({ "pages-Home": { path: "/x" } }, { out, deny: ["pages-*"] });
    expect(custom.denied).toEqual(["pages-Home"]);
  });

  it("never overwrites a block that carries an encrypted secret", () => {
    const out = tmpBlocksDir({
      "deco-vtex.json": { account: "loja", appKey: { name: "KEY", encrypted: "local" } },
    });
    const report = writeDecofileToDir(
      { "deco-vtex": { account: "outra", appKey: { name: "KEY", encrypted: "prod" } } },
      { out },
    );
    expect(report.protectedSecretBlocks).toEqual(["deco-vtex"]);
    expect(read(out, "deco-vtex.json").account).toBe("loja");

    const forced = writeDecofileToDir(
      { "deco-vtex": { account: "outra", appKey: { name: "KEY", encrypted: "prod" } } },
      { out, allowSecretBlocks: true },
    );
    expect(forced.updated).toEqual(["deco-vtex"]);
  });

  it("overwrites a legacy double-encoded filename in place instead of duplicating it", () => {
    const out = tmpBlocksDir({ "pages-A%2520B.json": { name: "old", path: "/a-b" } });
    const report = writeDecofileToDir({ "pages-A B": { name: "new", path: "/a-b" } }, { out });
    expect(report.updated).toEqual(["pages-A B"]);
    expect(ls(out)).toEqual(["pages-A%2520B.json"]);
    expect(read(out, "pages-A%2520B.json").name).toBe("new");
  });

  it("collapses colliding encodings onto the canonical name", () => {
    const out = tmpBlocksDir({
      "pages-A%2520B.json": { name: "stale", path: "/a-b" },
      "pages-A%20B.json": { name: "also stale", path: "/a-b" },
    });
    const report = writeDecofileToDir({ "pages-A B": { name: "new", path: "/a-b" } }, { out });
    expect(report.updated).toEqual(["pages-A B"]);
    expect(ls(out)).toEqual(["pages-A%20B.json"]);
    expect(read(out, "pages-A%20B.json").name).toBe("new");
  });

  it("prunes blocks absent upstream, but keeps denied and secret-bearing ones", () => {
    const out = tmpBlocksDir({
      "pages-Gone.json": { name: "gone", path: "/gone" },
      "pages-Home.json": { name: "home", path: "/" },
      "Site.json": { seo: {} },
      "deco-vtex.json": { appKey: { name: "KEY", encrypted: "local" } },
    });
    const report = writeDecofileToDir(
      { "pages-Home": { name: "home", path: "/" } },
      {
        out,
        prune: true,
      },
    );
    expect(report.removed).toEqual(["pages-Gone"]);
    expect(report.denied).toEqual(["Site"]);
    expect(report.protectedSecretBlocks).toEqual(["deco-vtex"]);
    expect(ls(out)).toEqual(["Site.json", "deco-vtex.json", "pages-Home.json"]);
  });

  it("--dry-run touches nothing", () => {
    const out = tmpBlocksDir({ "pages-Gone.json": { path: "/gone" } });
    const report = writeDecofileToDir(
      { "pages-Home": { path: "/" } },
      {
        out,
        prune: true,
        dryRun: true,
      },
    );
    expect(report.added).toEqual(["pages-Home"]);
    expect(report.removed).toEqual(["pages-Gone"]);
    expect(ls(out)).toEqual(["pages-Gone.json"]);
  });

  it("skips non-object payload values and reports plaintext secrets", () => {
    const out = tmpBlocksDir();
    const report = writeDecofileToDir(
      { broken: "not a block", leak: { appToken: "abcdefghijklmnop" } },
      { out },
    );
    expect(report.skipped).toEqual(["broken"]);
    expect(report.plaintextSecrets).toEqual(["leak.appToken"]);
  });
});

describe("fetchDecofile", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (body: string, init: { status?: number; headers?: Record<string, string> } = {}) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: init.status ?? 200,
            headers: { "content-type": "application/json", ...init.headers },
          }),
      ),
    );
  };

  it("returns the parsed decofile plus the ETag revision", async () => {
    stub(JSON.stringify({ "pages-Home": { path: "/" } }), { headers: { etag: '"abc123"' } });
    const result = await fetchDecofile("https://x.com/.decofile");
    expect(result.blocks).toEqual({ "pages-Home": { path: "/" } });
    expect(result.revision).toBe('"abc123"');
  });

  it("rejects a non-200, a non-JSON content-type, a non-object payload and an oversized body", async () => {
    stub("{}", { status: 500 });
    await expect(fetchDecofile("https://x.com/.decofile")).rejects.toThrow(/responded 500/);

    stub("<html>", { headers: { "content-type": "text/html" } });
    await expect(fetchDecofile("https://x.com/.decofile")).rejects.toThrow(/expected JSON/);

    stub("[]");
    await expect(fetchDecofile("https://x.com/.decofile")).rejects.toThrow(/an array/);

    stub(JSON.stringify({ a: { b: 1 } }));
    await expect(fetchDecofile("https://x.com/.decofile", { maxBytes: 4 })).rejects.toThrow(
      /over the 4 byte cap/,
    );
  });
});
