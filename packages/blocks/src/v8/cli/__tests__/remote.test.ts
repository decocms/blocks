// @vitest-environment node
/**
 * The remote content commands (spec: cli › The deco CLI; contract §7)
 * against a fake Studio API and CDN over real HTTP: pull, diff, push (with
 * batches, conflicts, --ours and --theirs), publish, drafts, releases, check
 * of a draft or a revision, schema push, the token, exit codes and --json.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blockVersion } from "../../../protocol/canonical";
import { blockFileName, serializeBlock } from "../../../protocol/keys";
import { TOMBSTONE_VERSION } from "../../../protocol/storage";
import { packBatches } from "../remote/commands";
import { applyRequestBody } from "../remote/http";
import { runCli } from "../run";
import { type FakeStudio, ORG, SITE, startFakeStudio, TOKEN } from "./fakeStudio";
import { createFixture, type Fixture, recorder } from "./fixture";

let fixture: Fixture;
let studio: FakeStudio;

beforeEach(async () => {
  studio = await startFakeStudio();
  fixture = createFixture({ ".deco/link.json": { org: ORG, site: SITE } });
});
afterEach(async () => {
  fixture?.remove();
  await studio?.close();
});

const hero = (title: string) => ({ __resolveType: "hero", title, size: "md" });

async function deco(argv: string[], extra: { env?: Record<string, string | undefined> } = {}) {
  const out = recorder();
  const json: string[] = [];
  const code = await runCli(argv, {
    cwd: fixture.root,
    reporter: out,
    env: { ...studio.env, ...extra.env },
    stdout: (text) => json.push(text),
    runCommand: async () => {
      throw new Error("no Studio CLI here");
    },
  });
  return {
    code,
    out,
    text: out.text(),
    json: json.length > 0 ? JSON.parse(json[json.length - 1]!) : undefined,
    stdoutLines: json,
  };
}

function block(name: string): unknown {
  return JSON.parse(fixture.read(`.deco/blocks/${blockFileName(name)}`));
}
function pullJson(): any {
  return JSON.parse(fixture.read(".deco/pull.json"));
}
function rpcCalls() {
  return studio.requests
    .filter((r) => r.path.endsWith("/rpc"))
    .map((r) => JSON.parse(r.body).params);
}

describe("deco login, init and link", () => {
  it("login prints Studio CLI's login, for the configured Studio", async () => {
    const r = await deco(["login"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain(`npx decocms auth login --target=${studio.studioUrl}`);
    expect(studio.requests).toHaveLength(0);
  });

  it("link writes .deco/link.json; init creates .deco/ too", async () => {
    expect((await deco(["link", "other/shop"])).code).toBe(0);
    expect(fixture.read(".deco/link.json")).toBe('{\n  "org": "other",\n  "site": "shop"\n}\n');
    fs.mkdirSync(path.join(fixture.root, "fresh"));
    expect((await deco(["init", "acme/fresh", "--root", "fresh"])).code).toBe(0);
    expect(JSON.parse(fixture.read("fresh/.deco/link.json"))).toEqual({
      org: "acme",
      site: "fresh",
    });
  });

  it("a bad target, or no link.json for a remote command, is a usage error (64)", async () => {
    expect((await deco(["link", "just-a-site"])).code).toBe(64);
    expect((await deco(["link"])).code).toBe(64);
    fs.rmSync(path.join(fixture.root, ".deco/link.json"));
    const r = await deco(["pull"]);
    expect(r.code).toBe(64);
    expect(r.text).toContain("deco link <org>/<site>");
  });
});

describe("deco pull", () => {
  it("writes production into .deco/blocks and pull.json, with no credentials", async () => {
    const revision = studio.release({ home: hero("Home"), "pages/a b": hero("A") });
    fixture.write(".deco/blocks/stale.json", hero("old"));
    const r = await deco(["pull", "--force"]);
    expect(r.code).toBe(0);
    expect(block("home")).toEqual(hero("Home"));
    expect(block("pages/a b")).toEqual(hero("A"));
    expect(fixture.exists(".deco/blocks/stale.json")).toBe(false);
    expect(fixture.read(`.deco/blocks/${blockFileName("home")}`)).toBe(
      serializeBlock(hero("Home")),
    );
    const state = pullJson();
    expect(state).toMatchObject({ format: 1, draft: null, revision });
    expect(state.blocks.home).toEqual({ hash: await blockVersion(hero("Home")), ifMatch: null });
    // Production pulls read only the CDN, never with a token.
    expect(studio.requests.every((q) => q.path.startsWith("/cdn/"))).toBe(true);
    expect(studio.requests.every((q) => q.headers.authorization === undefined)).toBe(true);
  });

  it("a draft pull layers the draft over production; ifMatch is draft-relative", async () => {
    studio.release({ home: hero("Home"), footer: hero("F"), gone: hero("G") });
    await studio.save("pdp", { home: hero("Draft home") }, ["gone"]);
    const r = await deco(["pull", "--draft=pdp"]);
    expect(r.code).toBe(0);
    expect(block("home")).toEqual(hero("Draft home"));
    expect(block("footer")).toEqual(hero("F"));
    expect(fixture.exists(".deco/blocks/gone.json")).toBe(false);
    const state = pullJson();
    expect(state.draft).toBe("pdp");
    expect(state.blocks.home.ifMatch).toBe(await blockVersion(hero("Draft home")));
    expect(state.blocks.footer.ifMatch).toBeNull();
    expect(state.blocks.gone).toEqual({ hash: null, ifMatch: TOMBSTONE_VERSION });
    const auth = studio.requests.find((q) => !q.path.startsWith("/cdn/"))!;
    expect(auth.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(auth.headers["user-agent"]).toMatch(/^deco-cli\//);
  });

  it("refuses to overwrite unpushed changes without --force", async () => {
    studio.release({ home: hero("Home") });
    expect((await deco(["pull"])).code).toBe(0);
    fixture.write(".deco/blocks/home.json", hero("Mine"));
    const r = await deco(["pull", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({
      ok: false,
      exitCode: 1,
      error: { code: "unpushed_changes" },
      changes: [{ name: "home", status: "changed" }],
    });
    expect(block("home")).toEqual(hero("Mine"));
    expect((await deco(["pull", "--force"])).code).toBe(0);
    expect(block("home")).toEqual(hero("Home"));
  });

  it("a site never published pulls as empty; the CDN unreachable exits 4", async () => {
    expect((await deco(["pull"])).code).toBe(0);
    expect(pullJson()).toMatchObject({ revision: null, blocks: {} });
    const down = await deco(["pull"], { env: { DECO_DELIVERY_URL: "http://127.0.0.1:9/cdn" } });
    expect(down.code).toBe(4);
  });

  it("a draft pull without a token exits 3 and tells how to log in", async () => {
    studio.release({ home: hero("Home") });
    await studio.save("pdp", { home: hero("x") });
    const r = await deco(["pull", "--draft=pdp"], { env: { DECO_TOKEN: undefined } });
    expect(r.code).toBe(3);
    expect(r.text).toContain(`run: npx decocms auth login --target=${studio.studioUrl}`);
  });
});

describe("deco diff", () => {
  it("shows what the folder changes against what was pulled", async () => {
    studio.release({ home: hero("Home"), footer: hero("F") });
    await deco(["pull"]);
    fixture.write(".deco/blocks/home.json", hero("New home"));
    fixture.write(".deco/blocks/promo.json", hero("P"));
    fs.rmSync(path.join(fixture.root, ".deco/blocks/footer.json"));
    const r = await deco(["diff", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json.changes).toEqual([
      { name: "footer", status: "deleted" },
      { name: "home", status: "changed" },
      { name: "promo", status: "new" },
    ]);
    expect(r.text).toContain('-   "title": "Home",');
    expect(r.text).toContain('+   "title": "New home",');
  });

  it("--draft compares the folder with a draft", async () => {
    studio.release({ home: hero("Home") });
    await deco(["pull"]);
    await studio.save("pdp", { home: hero("Theirs") });
    const r = await deco(["diff", "--draft=pdp", "--json"]);
    expect(r.json.changes).toEqual([{ name: "home", status: "changed" }]);
  });
});

describe("deco push", () => {
  it("sends only the changed, new and deleted blocks, each with its pulled ifMatch", async () => {
    studio.release({ home: hero("Home"), footer: hero("F"), keep: hero("K") });
    await deco(["pull"]);
    fixture.write(".deco/blocks/home.json", hero("New home"));
    fixture.write(".deco/blocks/promo.json", hero("P"));
    fs.rmSync(path.join(fixture.root, ".deco/blocks/footer.json"));
    const r = await deco(["push", "--draft=pdp"]);
    expect(r.code).toBe(0);
    expect(rpcCalls()).toEqual([
      {
        set: { home: hero("New home"), promo: hero("P") },
        delete: ["footer"],
        ifMatch: { footer: null, home: null, promo: null },
      },
    ]);
    const draft = studio.drafts.get("pdp")!;
    expect(draft.body.set).toEqual({ home: hero("New home"), promo: hero("P") });
    expect(draft.body.delete).toEqual(["footer"]);
    expect(r.text).toContain("preview: https://www.store.test/?__draft=");
    // pull.json now records the draft's versions: pushing again sends nothing.
    const state = pullJson();
    expect(state.draft).toBe("pdp");
    expect(state.blocks.home.ifMatch).toBe(await blockVersion(hero("New home")));
    expect(state.blocks.footer).toEqual({ hash: null, ifMatch: TOMBSTONE_VERSION });
    expect((await deco(["push", "--draft=pdp"])).code).toBe(0);
    expect(rpcCalls()).toHaveLength(1);
    // A second edit is guarded by the version the first push recorded.
    fixture.write(".deco/blocks/home.json", hero("Newer"));
    expect((await deco(["push", "--draft=pdp"])).code).toBe(0);
    expect(rpcCalls()[1]!.ifMatch).toEqual({ home: await blockVersion(hero("New home")) });
  });

  it("pushing to a draft other than the pulled one sends null for every block", async () => {
    studio.release({ home: hero("Home") });
    await studio.save("a", { home: hero("A") });
    await deco(["pull", "--draft=a"]);
    expect(pullJson().blocks.home.ifMatch).not.toBeNull();
    fixture.write(".deco/blocks/home.json", hero("Mine"));
    expect((await deco(["push", "--draft=b"])).code).toBe(0);
    expect(rpcCalls()[0]!.ifMatch).toEqual({ home: null });
    expect(pullJson().draft).toBe("b");
  });

  it("a conflict applies nothing, names who and when, and exits 2", async () => {
    studio.release({ home: hero("Home") });
    await studio.save("pdp", { home: hero("First") });
    await deco(["pull", "--draft=pdp"]);
    await studio.save("pdp", { home: hero("Theirs") }, [], "usr_456");
    fixture.write(".deco/blocks/home.json", hero("Mine"));
    const r = await deco(["push", "--draft=pdp", "--json"]);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({
      ok: false,
      exitCode: 2,
      error: { code: "conflict" },
      conflicts: {
        home: {
          expected: await blockVersion(hero("First")),
          actual: await blockVersion(hero("Theirs")),
          theirs: hero("Theirs"),
          editor: { userId: "usr_456" },
        },
      },
    });
    expect(r.text).toContain("conflict: home: changed by usr_456 at 20");
    expect(r.text).toContain('-   "title": "Theirs",');
    expect(r.text).toContain('+   "title": "Mine",');
    expect(studio.drafts.get("pdp")!.body.set.home).toEqual(hero("Theirs"));
  });

  it("--ours keeps yours: resends with the version it conflicted with", async () => {
    studio.release({ home: hero("Home") });
    await studio.save("pdp", { home: hero("First") });
    await deco(["pull", "--draft=pdp"]);
    await studio.save("pdp", { home: hero("Theirs") });
    fixture.write(".deco/blocks/home.json", hero("Mine"));
    const r = await deco(["push", "--draft=pdp", "--ours"]);
    expect(r.code).toBe(0);
    expect(studio.drafts.get("pdp")!.body.set.home).toEqual(hero("Mine"));
    expect(rpcCalls()[1]!.ifMatch.home).toBe(await blockVersion(hero("Theirs")));
  });

  it("--theirs takes theirs into .deco/blocks and sends the rest", async () => {
    studio.release({ home: hero("Home"), footer: hero("F") });
    await studio.save("pdp", { home: hero("First") });
    await deco(["pull", "--draft=pdp"]);
    await studio.save("pdp", { home: hero("Theirs") });
    fixture.write(".deco/blocks/home.json", hero("Mine"));
    fixture.write(".deco/blocks/footer.json", hero("My footer"));
    const r = await deco(["push", "--draft=pdp", "--theirs"]);
    expect(r.code).toBe(0);
    expect(block("home")).toEqual(hero("Theirs"));
    expect(studio.drafts.get("pdp")!.body.set).toEqual({
      home: hero("Theirs"),
      footer: hero("My footer"),
    });
    expect(rpcCalls()[1]).toEqual({
      set: { footer: hero("My footer") },
      delete: [],
      ifMatch: { footer: null },
    });
    expect(pullJson().blocks.home.ifMatch).toBe(await blockVersion(hero("Theirs")));
    // Nothing left to push.
    expect((await deco(["diff", "--json"])).json.changes).toEqual([]);
  });

  it("--ours with --theirs, or no --draft, is a usage error", async () => {
    expect((await deco(["push"])).code).toBe(64);
    expect((await deco(["push", "--draft=x", "--ours", "--theirs"])).code).toBe(64);
    expect((await deco(["push", "--draft=-bad"])).code).toBe(64);
    expect((await deco(["push", "--draft=x", "--nope"])).code).toBe(64);
  });

  it("Unavailable exits 5 and applies nothing; a 401 exits 3; a 5xx exits 4", async () => {
    studio.release({ home: hero("Home") });
    await deco(["pull"]);
    fixture.write(".deco/blocks/home.json", hero("Mine"));
    studio.inject.set("POST /drafts/pdp/rpc", [
      {
        status: 200,
        json: {
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32008, message: "busy", data: { retryAfterMs: 250 } },
        },
      },
    ]);
    const busy = await deco(["push", "--draft=pdp", "--json"]);
    expect(busy.code).toBe(5);
    expect(busy.json.error.code).toBe("unavailable");
    expect(studio.drafts.get("pdp")!.body.set).toEqual({});
    expect((await deco(["push", "--draft=pdp"], { env: { DECO_TOKEN: "wrong" } })).code).toBe(3);
    studio.inject.set("POST /drafts", [{ status: 502, json: { error: "bad gateway" } }]);
    expect((await deco(["push", "--draft=pdp"])).code).toBe(4);
    studio.inject.set("POST /drafts", [{ status: 429, json: { error: "slow down" } }]);
    expect((await deco(["push", "--draft=pdp"])).code).toBe(5);
    expect((await deco(["push", "--draft=pdp"])).code).toBe(0);
  });

  it("splits a large push into saves under 8 MiB, and a rerun after a failed save resumes", async () => {
    const big = (n: number) => ({
      __resolveType: "hero",
      title: String(n),
      size: "x".repeat(3 * 1024 * 1024),
    });
    studio.release({});
    await deco(["pull"]);
    for (let i = 0; i < 5; i++) fixture.write(`.deco/blocks/b${i}.json`, big(i));
    // Two blocks per save: the first save lands, the second is answered busy.
    studio.inject.set("POST /drafts/pdp/rpc", [
      {
        status: 200,
        after: 1,
        json: { jsonrpc: "2.0", id: 1, error: { code: -32008, message: "busy" } },
      },
    ]);
    const failed = await deco(["push", "--draft=pdp", "--json"]);
    expect(failed.code).toBe(5);
    expect(failed.json).toMatchObject({ pushed: 2, batch: 2, batches: 3 });
    expect(Object.keys(studio.drafts.get("pdp")!.body.set).sort()).toEqual(["b0", "b1"]);
    const before = rpcCalls().length;
    expect(before).toBe(2);
    expect((await deco(["push", "--draft=pdp"])).code).toBe(0);
    const resent = rpcCalls().slice(before);
    expect(resent.map((p) => Object.keys(p.set).sort())).toEqual([["b2", "b3"], ["b4"]]);
    for (const r of studio.requests.filter((q) => q.path.endsWith("/rpc")))
      expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(Object.keys(studio.drafts.get("pdp")!.body.set).sort()).toEqual([
      "b0",
      "b1",
      "b2",
      "b3",
      "b4",
    ]);
  }, 60_000);
});

describe("push batching", () => {
  it("packs exactly: every batch's serialized request is at most the limit", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      name: `n${i}`,
      block: { __resolveType: "x", v: "é".repeat(i * 7) },
      hash: "h",
      ifMatch: i % 3 === 0 ? null : "v",
    }));
    items.push({
      name: "gone",
      block: undefined as never,
      hash: null as never,
      ifMatch: "tombstone",
    });
    for (const limit of [800, 1500, 5000]) {
      const batches = packBatches(items as never, limit);
      expect(batches.flat()).toHaveLength(items.length);
      if (limit === 800) expect(batches.length).toBeGreaterThan(5);
      for (const batch of batches) {
        const params = {
          set: Object.fromEntries(batch.filter((i) => i.block).map((i) => [i.name, i.block])),
          delete: batch.filter((i) => !i.block).map((i) => i.name),
          ifMatch: Object.fromEntries(batch.map((i) => [i.name, i.ifMatch])),
        };
        expect(Buffer.byteLength(applyRequestBody(params as never))).toBeLessThanOrEqual(limit);
      }
    }
    expect(() => packBatches(items as never, 100)).toThrow(/alone is larger/);
  });
});

describe("deco publish", () => {
  it("prints the draft's changes, then makes it live", async () => {
    const before = studio.release({ home: hero("Home") });
    await studio.save("pdp", { home: hero("New") });
    const r = await deco(["publish", "--draft=pdp", "--message=Black Friday", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      ok: true,
      result: "published",
      previous: before,
      draftEmptied: true,
    });
    expect(r.text).toContain('+   "title": "New",');
    expect(studio.revisions.get(studio.latest!)!.meta).toMatchObject({
      draft: "pdp",
      message: "Black Friday",
    });
    expect((await deco(["publish", "--draft=pdp", "--json"])).json.result).toBe("up-to-date");
  });

  it("production moved exits 5; an unknown draft exits 1; no --draft is 64", async () => {
    studio.release({});
    await studio.save("pdp", { home: hero("New") });
    studio.inject.set("POST /drafts/pdp/publish", [
      { status: 409, json: { error: "production moved, try again", code: "production_moved" } },
    ]);
    expect((await deco(["publish", "--draft=pdp"])).code).toBe(5);
    studio.inject.set("POST /drafts/pdp/publish", [
      { status: 503, json: { error: "x", code: "unavailable" } },
    ]);
    expect((await deco(["publish", "--draft=pdp"])).code).toBe(5);
    expect((await deco(["publish", "--draft=nope"])).code).toBe(1);
    expect((await deco(["publish"])).code).toBe(64);
  });
});

describe("deco drafts and releases", () => {
  it("new, list, url and discard", async () => {
    const created = await deco(["drafts", "new", "feature/x", "--json"]);
    expect(created.code).toBe(0);
    expect(created.json.draft).toMatchObject({ name: "feature/x", created: true });
    // The name travels encoded: a / is %2F in the path.
    expect(studio.requests.at(-1)!.path).toBe(`/api/${ORG}/cms/${SITE}/drafts`);
    expect((await deco(["drafts", "new", "feature/x", "--json"])).json.draft.created).toBe(false);
    const list = await deco(["drafts", "list", "--json"]);
    expect(list.json.drafts.map((d: { name: string }) => d.name)).toEqual(["feature/x"]);
    const url = await deco(["drafts", "url", "feature/x"]);
    expect(url.text).toMatch(/^https:\/\/www\.store\.test\/\?__draft=/);
    expect(studio.requests.at(-1)!.path).toBe(`/api/${ORG}/cms/${SITE}/drafts/feature%2Fx`);
    expect((await deco(["drafts", "discard", "feature/x"])).code).toBe(0);
    expect(studio.drafts.size).toBe(0);
    expect((await deco(["drafts", "url", "feature/x"])).code).toBe(1);
    expect((await deco(["drafts"])).code).toBe(64);
    expect((await deco(["drafts", "new"])).code).toBe(64);
  });

  it("releases lists a page and prints the next cursor", async () => {
    studio.release({ a: hero("1") });
    studio.release({ a: hero("2") });
    studio.release({ a: hero("3") });
    const r = await deco(["releases", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json.revisions).toHaveLength(2);
    expect(r.json.nextCursor).toBe("2");
    expect(r.text).toContain("more: deco releases --cursor=2");
    const next = await deco(["releases", "--cursor=2", "--json"]);
    expect(next.json.revisions).toHaveLength(1);
    expect(next.json.nextCursor).toBeNull();
  });
});

describe("deco schema push and the token", () => {
  it("uploads .deco/schema.gen.json byte for byte", async () => {
    const text = '{\n  "blocksMajor": 8,\n  "x": "é"\n}\n';
    fixture.write(".deco/schema.gen.json", text);
    const r = await deco(["schema", "push", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ ok: true, etag: "schemaetag", blocksMajor: 8 });
    expect(studio.schema).toBe(text);
    const put = studio.requests.at(-1)!;
    expect(put.method).toBe("PUT");
    expect(put.headers["content-type"]).toBe("application/json");
    fs.rmSync(path.join(fixture.root, ".deco/schema.gen.json"));
    expect((await deco(["schema", "push"])).code).toBe(1);
    expect((await deco(["schema", "pull"])).code).toBe(64);
  });

  it("without DECO_TOKEN, runs npx decocms auth token --target=<DECO_STUDIO_URL>", async () => {
    const calls: string[][] = [];
    const out = recorder();
    const code = await runCli(["drafts", "list"], {
      cwd: fixture.root,
      reporter: out,
      env: { DECO_STUDIO_URL: `${studio.studioUrl}/`, DECO_DELIVERY_URL: studio.deliveryUrl },
      runCommand: async (file, args) => {
        calls.push([file, ...args]);
        return `${TOKEN}\n`;
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([["npx", "decocms", "auth", "token", `--target=${studio.studioUrl}`]]);
    const empty = await runCli(["drafts", "list"], {
      cwd: fixture.root,
      reporter: recorder(),
      env: { DECO_STUDIO_URL: studio.studioUrl },
      runCommand: async () => "  \n",
    });
    expect(empty).toBe(3);
  });
});

describe("deco check --draft and --revision", () => {
  beforeEach(async () => {
    fixture.write(
      "src/a.tsx",
      "export const hero = (props: { title: string; size: string }) => <p>{props.title}</p>;",
    );
    fixture.write(".deco/index.ts", 'import { hero } from "../src/a"; export default { hero };');
    expect((await deco(["schema"])).code).toBe(0);
  }, 60_000);

  it("checks a revision or a draft against the local schema, without touching .deco/blocks", async () => {
    const good = studio.release({ home: hero("Home") });
    const bad = studio.release({ home: { __resolveType: "hero", title: 3, size: "md" } });
    const ok = await deco(["check", `--revision=${good}`, "--json"]);
    expect(ok.code).toBe(0);
    expect(ok.json).toMatchObject({ ok: true, blocks: 1, errors: 0 });
    const failed = await deco(["check", `--revision=${bad}`, "--json"]);
    expect(failed.code).toBe(1);
    expect(failed.json).toMatchObject({ ok: false, exitCode: 1, error: { code: "check_failed" } });
    await studio.save("fix", { home: hero("Fixed") });
    expect((await deco(["check", "--draft=fix"])).code).toBe(0);
    expect(fs.readdirSync(path.join(fixture.root, ".deco/blocks"))).toEqual([]);
    expect((await deco(["check", "--draft=fix", `--revision=${good}`])).code).toBe(64);
    expect((await deco(["check", "--revision=abc"])).code).toBe(64);
  }, 60_000);
});

describe("--json", () => {
  it("prints exactly one object on stdout, for success and failure", async () => {
    studio.release({ home: hero("Home") });
    const r = await deco(["pull", "--json"]);
    expect(r.stdoutLines).toHaveLength(1);
    expect(r.json).toMatchObject({ ok: true, draft: null, blocks: 1 });
    const usage = await deco(["push", "--json"]);
    expect(usage.stdoutLines).toHaveLength(1);
    expect(usage.json).toMatchObject({ ok: false, exitCode: 64, error: { code: "usage" } });
  });
});
