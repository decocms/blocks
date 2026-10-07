// @vitest-environment node
/**
 * Conformance: the docs (deco-sites/docs-tanstack src/content/docs/en/storefront/blocks/next: api-reference,
 * content, releases-and-drafts, routing, router-internals, rendering) are the
 * source of truth. Each `describe` names the claim it checks. A failing test
 * here is a gap between the docs and the code, to be fixed in one of them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as root from "../../index";
import { generateSecretsKeyPair } from "../../protocol/__tests__/fixtures";
import * as analyticsModule from "../analytics";
import { AnalyticsScript, track } from "../analytics";
import { instanceOf } from "../cms";
import * as fetchModule from "../fetch";
import { createInstrumentedFetch } from "../fetch";
import * as v8 from "../index";
import {
  createCMS,
  formatDraftPointer,
  matchRoute,
  parseDraftPointer,
  remoteLoader,
  resetForTests,
} from "../index";
import * as secretsModule from "../secrets";
import { encryptSecret } from "../secrets";
import { resolveDestination, setCurrentTelemetry, TelemetryPipeline } from "../telemetry";
import { docsBlocks, docsSnapshot, fakeStudio, hero, seo } from "../testFixtures";
import type { Blocks, CMS, Redirect, RequestLike, Route, Snapshot } from "../types";
import { typecheck } from "./typecheck";

/** cms.draftPointer and cms.draftCookie, on a CMS with no settings: every host may preview. */
const helpers = () => createCMS({ blocks: {}, content: { revision: "draft-helpers", blocks: {} } });
const draftPointer = (request: RequestLike) => helpers().draftPointer(request);
const draftCookie = (request: RequestLike) => helpers().draftCookie(request);
const DRAFT_COOKIE = "__deco_draft";

/** A fake Studio holding one draft that retitles SummerSEO; returns its pointer and the stubbed fetch. */
function studioDraft(title = "Draft!") {
  const studio = fakeStudio();
  const fetch = vi.fn(studio.fetch);
  vi.stubGlobal("fetch", fetch);
  const pointer = studio.draft({
    set: { SummerSEO: { __resolveType: "seo", title, description: "Light layers for long days." } },
  });
  return { studio, fetch, pointer };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../../..");
const readSource = (rel: string) => fs.readFileSync(path.join(pkgRoot, rel), "utf8");

const BACKGROUND_HOOK = Symbol.for("decocms.blocks.background");
let tasks: (() => Promise<void>)[] = [];

beforeEach(() => {
  resetForTests();
  tasks = [];
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[BACKGROUND_HOOK];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetForTests();
});

/** Queues background work instead of running it, as a Workers binding would. */
function captureBackground() {
  (globalThis as Record<symbol, unknown>)[BACKGROUND_HOOK] = (task: () => Promise<void>) =>
    tasks.push(task);
}
async function runBackground() {
  while (tasks.length > 0) await Promise.all(tasks.splice(0).map((t) => t()));
}

/** A loader with `update()` whose content can be swapped. */
function swappableLoader(first: Snapshot) {
  let current = first;
  let next: Snapshot | undefined;
  const loader = {
    load: vi.fn(async (_pointer?: string | null) => current),
    update: vi.fn(async () => {
      if (!next) return { updated: false };
      current = next;
      next = undefined;
      return { updated: true };
    }),
  };
  const publish = (s: Snapshot) => {
    next = s;
  };
  return { loader, publish };
}

/** PKCS#8 PEM of a freshly generated key pair's private key, plus the public PEM. */
async function keyPair() {
  const { privateKey, publicKeyPem } = await generateSecretsKeyPair();
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  const b64 = btoa(String.fromCharCode(...der)).replace(/.{64}/g, "$&\n");
  return {
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
    publicKeyPem,
  };
}

/** The names a source file re-exports from `from`, in its `export { … } from` block. */
function exportedNames(source: string, from: string): string[] {
  const re = new RegExp(`export\\s*\\{([^}]*)\\}\\s*from\\s*"${from.replace(/[./]/g, "\\$&")}"`);
  const block = re.exec(source)?.[1] ?? "";
  return block
    .split(",")
    .map((s) => s.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .sort();
}

// ---------------------------------------------------------------------------
// api-reference
// ---------------------------------------------------------------------------

const DOCUMENTED_ROOT_VALUES = [
  "createCMS",
  "formatDraftPointer",
  "matchRoute",
  "parseDraftPointer",
  "remoteLoader",
  "resetForTests",
].sort();
const DOCUMENTED_ROOT_TYPES = [
  "Block",
  "BlockFunction",
  "Blocks",
  "Snapshot",
  "Loader",
  "DraftPointer",
  "Route",
  "Seo",
  "Page",
  "Redirect",
  "Secret",
  "Lazy",
  "Variant",
  "Telemetry",
  "Analytics",
  "CMSSettings",
  "EffectiveSettings",
  "RequestLike",
  "Match",
  "Result",
  "CMSError",
  "CMS",
  "Client",
  "ListOptions",
  "TelemetryConfig",
];

describe("AR-01 the root exports exactly the documented v8 surface", () => {
  it("runtime values of the v8 entry are the documented ones", () => {
    expect(Object.keys(v8).sort()).toEqual(DOCUMENTED_ROOT_VALUES);
  });

  it("the root's v8 block re-exports only documented names (no extra types)", () => {
    const names = exportedNames(readSource("src/index.ts"), "./v8/index.ts");
    expect(names).toEqual([...DOCUMENTED_ROOT_VALUES, ...DOCUMENTED_ROOT_TYPES].sort());
  });
});

describe("AR-02 fetch, analytics and secrets live on their own subpaths", () => {
  it("package.json maps the subpaths to the v8 modules", () => {
    const pkg = JSON.parse(readSource("package.json"));
    for (const name of ["fetch", "analytics", "secrets"]) {
      expect(pkg.exports[`./${name}`]).toEqual({
        types: `./dist/v8/${name}.d.ts`,
        source: `./src/v8/${name}.ts`,
        default: `./dist/v8/${name}.js`,
      });
    }
  });

  it("each subpath exports exactly the documented runtime names", () => {
    expect(Object.keys(fetchModule)).toEqual(["createInstrumentedFetch"]);
    expect(Object.keys(analyticsModule).sort()).toEqual(["AnalyticsScript", "track"]);
    expect(Object.keys(secretsModule)).toEqual(["encryptSecret"]);
  });

  it("each subpath exports no undocumented types either", () => {
    const exportedTypes = (rel: string) =>
      [...readSource(rel).matchAll(/^export\s+(?:interface|type)\s+(\w+)/gm)].map((m) => m[1]);
    expect(exportedTypes("src/v8/fetch.ts")).toEqual([]);
    expect(exportedTypes("src/v8/analytics.ts")).toEqual([]);
    expect(exportedTypes("src/v8/secrets.ts")).toEqual([]);
  });

  it("the root doesn't re-export them", () => {
    const r = root as Record<string, unknown>;
    expect(r.createInstrumentedFetch).toBeUndefined();
    expect(r.track).toBeUndefined();
    expect(r.AnalyticsScript).toBeUndefined();
    expect(r.encryptSecret).toBeUndefined();
  });
});

describe("AR-03 built-ins need no import and a block-map key overrides one", () => {
  it("a key in the block map overrides the built-in page", async () => {
    const cms = createCMS({
      blocks: { ...docsBlocks(), page: () => ({ custom: true }) },
      content: docsSnapshot(),
    });
    expect(await cms.forRelease().resolve("SummerPage")).toEqual([{ custom: true }, null]);
  });

  it("without an override the built-in page works", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const [page, error] = await cms.forRelease().resolve<{ path: string }>("SummerPage");
    expect(error).toBeNull();
    expect(page?.path).toBe("/summer");
  });
});

describe("AR-04 / AR-10 / AR-14 / AR-48 / AR-57 / AR-58 / AR-62 documented signatures", () => {
  it("createCMS takes only the documented options; CMS and Client have only the documented methods", () => {
    const errors = typecheck({
      "sig.ts": `
import { createCMS, type Blocks, type CMS, type Client, type Snapshot, type Loader, type ListOptions,
  type Result, type CMSError, type Block, type BlockFunction, type Route, type Seo, type Page,
  type Redirect, type Secret, type Lazy, type Variant, type TelemetryConfig, type Telemetry, type Analytics,
  type CMSSettings, type EffectiveSettings, type RequestLike } from "@decocms/blocks";
import type { ReactNode } from "react";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assert = <T extends true>() => {};

declare const blocks: Blocks;
declare const content: Snapshot;
declare const loader: Loader;
createCMS({ blocks, content });
createCMS({ blocks, content: loader, interval: 60_000, telemetry: false, secrets: { key: "k" }, site: "s", token: "t" });
createCMS({ blocks, content, site: "s", token: "t", telemetry: { limits: { errorSampleRate: 0.1, traceSampleRate: 0 } } });
createCMS({ blocks, content, telemetry: { endpoint: "https://otel.example", headers: { a: "b" }, resource: { "service.version": "abc" } } });
createCMS({ blocks, content, preview: { hosts: ["*.example.com", "localhost:3000"], draftHosts: [".decocms.com"] } });
// @ts-expect-error draft hosts are preview.draftHosts
createCMS({ blocks, content, preview: { sources: ["studio.example.com"] } });
// @ts-expect-error the telemetry: { site, token } form is gone: site and token are top-level
createCMS({ blocks, content, telemetry: { site: "s", token: "t" } });
// @ts-expect-error not a documented option
createCMS({ blocks, content, ignoreCase: true });

assert<Equal<keyof CMS, "forRelease" | "forDraft" | "update" | "settings" | "draftPointer" | "draftCookie">>();
assert<Equal<CMS["settings"], () => Promise<EffectiveSettings>>>();
assert<Equal<CMS["draftPointer"], (request: RequestLike) => Promise<string | null>>>();
assert<Equal<CMS["draftCookie"], (request: RequestLike) => Promise<string | null>>>();
assert<Equal<RequestLike, Request | { url: string; headers: { get(name: string): string | null } }>>();
assert<Equal<CMSSettings, { preview?: { hosts?: string[] }; telemetry?: Telemetry; analytics?: Analytics }>>();
assert<Equal<EffectiveSettings, { preview: { hosts: string[] }; telemetry: Required<Telemetry>; analytics: Required<Analytics> }>>();
assert<Equal<CMS["forDraft"], (pointer: string) => Client>>();
assert<Equal<CMS["update"], () => Promise<{ updated: boolean }>>>();
assert<Equal<keyof Client, "resolve" | "list" | "revision">>();
assert<Equal<Client["revision"], () => Promise<string>>>();
declare const client: Client;
const r1: Promise<Result<unknown>> = client.resolve("x");
const r2: Promise<Result<number>> = client.resolve<number>({}, { run: false });
const r3: Promise<Result<Block[]>> = client.list("post");
assert<Equal<ListOptions<number>, { where?: (entry: number) => boolean; sort?: (a: number, b: number) => number; limit?: number; run?: boolean }>>();

assert<Equal<Block, { __resolveType: string; [input: string]: unknown }>>();
assert<Equal<BlockFunction, (inputs: any) => unknown | Promise<unknown>>>();
assert<Equal<Blocks, Record<string, BlockFunction>>>();
assert<Equal<Loader["load"], () => Promise<Snapshot>>>();
assert<Equal<Route, { name: string; path: string }>>();
assert<Equal<Seo, { title: string; description: string }>>();
assert<Equal<Page, { name: string; path: string; seo?: Seo; sections: ReactNode[] }>>();
assert<Equal<Redirect, { from: string; to: string; permanent: boolean; status?: 301 | 302 | 307 | 308; discardQueryParameters?: boolean }>>();
assert<Equal<Secret, string & { readonly __secret: true }>>();
assert<Equal<Lazy<number>, () => Promise<number>>>();
assert<Equal<Variant<number>, { rule: boolean; value: Lazy<number> }>>();
assert<Equal<Telemetry, { enabled?: boolean; metrics?: boolean; errorSampleRate?: number; traceSampleRate?: number }>>();
assert<Equal<Analytics, { collector?: string; enabled?: boolean }>>();
assert<Equal<CMSError["code"], "NOT_FOUND" | "UNKNOWN_BLOCK" | "CYCLE" | "BLOCK_FAILED" | "LOADER_FAILED">>();
assert<Equal<CMSError, { code: CMSError["code"]; message: string; path: (string | number)[]; cause?: unknown }>>();
assert<Equal<Result<number>, [number, null] | [null, CMSError]>>();
assert<Equal<TelemetryConfig, { endpoint?: string; headers?: Record<string, string>; resource?: Record<string, string>; limits?: { errorSampleRate?: number; traceSampleRate?: number } }>>();
export { r1, r2, r3 };
`,
    });
    expect(errors).toEqual([]);
  }, 60_000);

  it("AR-57 Snapshot is exactly { revision, blocks, aliases?, schemaHash? }", () => {
    const errors = typecheck({
      "snapshot.ts": `
import type { Snapshot } from "@decocms/blocks";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assert = <T extends true>() => {};
assert<Equal<Snapshot, { revision: string; blocks: Record<string, unknown>; aliases?: Record<string, string>; schemaHash?: string }>>();
`,
    });
    expect(errors).toEqual([]);
  }, 60_000);
});

describe("AR-05 interval: default 60 000, minimum 60 000; no environment variable", () => {
  const intervalOf = (cms: CMS) =>
    (instanceOf(cms) as { fingerprint: { interval: number } }).fingerprint.interval;

  it("clamps a value below the minimum", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createCMS({ blocks: {}, content: docsSnapshot(), interval: 1000 });
    expect(intervalOf(cms)).toBe(60_000);
  });

  it("defaults to 60 000 and never reads DECO_CONTENT_INTERVAL", () => {
    expect(intervalOf(createCMS({ blocks: {}, content: docsSnapshot() }))).toBe(60_000);
    resetForTests();
    vi.stubEnv("DECO_CONTENT_INTERVAL", "120000");
    expect(intervalOf(createCMS({ blocks: {}, content: docsSnapshot() }))).toBe(60_000);
    resetForTests();
    expect(intervalOf(createCMS({ blocks: {}, content: docsSnapshot(), interval: 120_000 }))).toBe(
      120_000,
    );
  });
});

describe("AR-06 / AR-07 telemetry destination and limits", () => {
  it("limits default to 0.1 and 0", () => {
    expect(resolveDestination({ endpoint: "https://otel.example" })?.limits).toEqual({
      errorSampleRate: 0.1,
      traceSampleRate: 0,
    });
    expect(resolveDestination(undefined, "s", "t")?.limits).toEqual({
      errorSampleRate: 0.1,
      traceSampleRate: 0,
    });
  });

  it("false sends nothing, even with a token", () => {
    expect(resolveDestination(false, "s", "t")).toBeNull();
  });

  it("an endpoint sends there, with its headers", () => {
    expect(
      resolveDestination({ endpoint: "https://otel.example", headers: { a: "b" } }, "s", "t"),
    ).toMatchObject({ endpoint: "https://otel.example", headers: { a: "b" } });
  });

  it("omitted: the token's hosted collector, otherwise nothing; OTEL_* variables aren't read", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://env.example");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "x-key=abc");
    expect(resolveDestination(undefined)).toBeNull();
    expect(resolveDestination(undefined, "s", "t")).toMatchObject({
      endpoint: "https://otel.decocms.com",
      headers: { authorization: "Bearer t" },
    });
  });
});

describe("AR-08 site loads hosted releases; token sends telemetry; neither is needed for drafts", () => {
  it("site alone: releases from delivery, no telemetry", async () => {
    const { currentTelemetry } = await import("../telemetry");
    const fetch = vi.fn(
      async (_input: string | URL | Request) => new Response("{}", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetch);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: { ...docsSnapshot(), schemaHash: "5".repeat(64) },
      site: "acme",
    });
    const [seo] = await cms.forRelease().resolve("SummerSEO");
    expect(seo).toEqual({ title: "Sunny!", description: "Light layers for long days." });
    expect(await cms.update()).toEqual({ updated: false });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://delivery.decocms.com/sites/acme/latest.json",
    ]);
    expect(currentTelemetry()).toBeUndefined();
  });

  it("token alone is a configuration error: token needs site", () => {
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    expect(() => createCMS({ blocks: docsBlocks(), content: docsSnapshot(), token: "t" })).toThrow(
      "token needs site: pass both, or site alone",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drafts don't need site or token", async () => {
    const { pointer } = studioDraft();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const [seo] = await cms.forDraft(pointer).resolve<{ title: string }>("SummerSEO");
    expect(seo?.title).toBe("Draft!");
  });
});

describe("AR-09 / AR-56 secrets", () => {
  it("encryptSecret returns a secret block the CMS decrypts with secrets.key; without it the block fails", async () => {
    const { privateKeyPem, publicKeyPem } = await keyPair();
    const block = await encryptSecret(publicKeyPem, "s3cret");
    expect(block.__resolveType).toBe("secret");
    expect(typeof block.ciphertext).toBe("string");

    const content: Snapshot = { revision: "r", blocks: { ApiKey: block } };
    const withKey = createCMS({ blocks: {}, content, secrets: { key: privateKeyPem } });
    expect(await withKey.forRelease().resolve("ApiKey")).toEqual(["s3cret", null]);

    resetForTests();
    const withoutKey = createCMS({ blocks: {}, content: { ...content } });
    const [value, error] = await withoutKey.forRelease().resolve("ApiKey");
    expect(value).toBeNull();
    expect(error?.code).toBe("BLOCK_FAILED");
  }, 30_000);
});

describe("AR-11 / AR-20 / AR-26 / RD-03 / CT-09 drafts", () => {
  it("forDraft layers the pointer's changes over the content module", async () => {
    const { pointer } = studioDraft();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const draft = cms.forDraft(pointer);
    expect((await draft.resolve<{ title: string }>("SummerSEO"))[0]?.title).toBe("Draft!");
    expect((await draft.resolve("HomePage"))[1]).toBeNull();
    expect(await draft.revision()).toBe('rev-1~"etag-1"');
  });

  it("a draft whose changes can't be fetched makes every call return LOADER_FAILED with the cause", async () => {
    const { studio, pointer } = studioDraft();
    studio.respond("summer-sale", () => new Response("down", { status: 502 }));
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const client = cms.forDraft(pointer);
    const [value, error] = await client.resolve("SummerSEO");
    expect(value).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
    expect(String((error?.cause as Error | undefined)?.message)).toContain("HTTP 502");
    const [list, listError] = await client.list("page");
    expect(list).toBeNull();
    expect(listError?.code).toBe("LOADER_FAILED");
  });

  it("a pointer that doesn't parse, or names a host outside the draft hosts, is LOADER_FAILED with no fetch", async () => {
    const { fetch } = studioDraft();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    for (const pointer of ["garbage", "api.deco.example/drafts/acme/main@9f3c1a"]) {
      const client = cms.forDraft(pointer);
      expect((await client.resolve("SummerSEO"))[1]?.code).toBe("LOADER_FAILED");
      expect((await client.list("page"))[1]?.code).toBe("LOADER_FAILED");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a snapshot source has no scheduled checks", async () => {
    captureBackground();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    await cms.forRelease().resolve("SummerSEO");
    expect(tasks).toHaveLength(0);
    expect(await cms.update()).toEqual({ updated: false });
  });
});

describe("AR-66 a draft pointer's forced variants (releases-and-drafts#preview-a-variant)", () => {
  const flag = (n: number) => ({
    rule: { __resolveType: "segment", n },
    value: { __resolveType: "lazy", value: { __resolveType: "heavy", n } },
  });
  const content = (): Snapshot => ({
    revision: "r1",
    blocks: {
      Home: {
        __resolveType: "page",
        name: "Home",
        path: "/",
        sections: [{ __resolveType: "multivariate", variants: [flag(0), flag(1), flag(2)] }],
      },
      Banner: {
        __resolveType: "website/flags/multivariate.ts",
        variants: [
          { rule: { __resolveType: "always" }, value: "spring" },
          { rule: { __resolveType: "never" }, value: "summer" },
        ],
      },
    },
  });
  const pointer = (...variants: { block: string; path: string; index: number }[]) =>
    formatDraftPointer({ host: "localhost:4547", path: "/", version: "local", variants });

  it("the content module has no drafts, yet forDraft applies them; no rule runs; the release is untouched", async () => {
    const segment = vi.fn(({ n }: { n: number }) => n === 0);
    const heavy = vi.fn(({ n }: { n: number }) => `variant ${n}`);
    const cms = createCMS({ blocks: { segment, heavy }, content: content() });
    const draft = cms.forDraft(pointer({ block: "Home", path: "sections.0", index: 2 }));
    const [page] = await draft.resolve<{ sections: unknown[] }>("Home");
    expect(page?.sections).toEqual(["variant 2"]);
    expect(segment).not.toHaveBeenCalled();
    expect(heavy).toHaveBeenCalledTimes(1);
    const [release] = await cms.forRelease().resolve<{ sections: unknown[] }>("Home");
    expect(release?.sections).toEqual(["variant 0"]);
    expect(await draft.revision()).toBe("r1");
  });

  it("the documented example, as written", () => {
    expect(
      formatDraftPointer({
        host: "localhost:4547",
        path: "/",
        version: "local",
        variants: [{ block: "Home", path: "sections.3", index: 1 }],
      }),
    ).toBe("localhost:4547/?__variant=Home%40sections.3%3D1@local");
  });

  it("a legacy multivariate saved on its own is addressed with an empty path", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: content() });
    const [value] = await cms
      .forDraft(pointer({ block: "Banner", path: "", index: 1 }))
      .resolve("Banner");
    expect(value).toBe("summer");
  });

  it("a stale address renders the content as saved", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: content() });
    const [value, error] = await cms
      .forDraft(pointer({ block: "Banner", path: "variants.0", index: 1 }))
      .resolve("Banner");
    expect([value, error]).toEqual(["spring", null]);
  });

  it("a draft is fetched without them, one body for every variant of one draft (later reads revalidate it)", async () => {
    const { fetch, pointer } = studioDraft();
    const cms = createCMS({ blocks: docsBlocks(), content: content() });
    const draft = (index: number) =>
      formatDraftPointer({
        ...parseDraftPointer(pointer)!,
        variants: [{ block: "Banner", path: "", index }],
      });
    expect((await cms.forDraft(draft(1)).resolve("Banner"))[0]).toBe("summer");
    expect((await cms.forDraft(draft(0)).resolve("Banner"))[0]).toBe("spring");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]![0])).toBe(String(fetch.mock.calls[1]![0]));
    expect(String(fetch.mock.calls[0]![0])).not.toContain("__variant");
    expect((await fetch.mock.results[1]!.value).status).toBe(304);
  });
});

describe("AR-13 cms.update() never throws", () => {
  it("a loader whose update throws -> { updated: false }", async () => {
    const cms = createCMS({
      blocks: {},
      content: {
        load: async () => docsSnapshot(),
        update: async () => {
          throw new Error("boom");
        },
      },
    });
    await expect(cms.update()).resolves.toEqual({ updated: false });
  });

  it("a loader without update() and a snapshot -> { updated: false }", async () => {
    expect(
      await createCMS({ blocks: {}, content: { load: async () => docsSnapshot() } }).update(),
    ).toEqual({
      updated: false,
    });
    expect(await createCMS({ blocks: {}, content: docsSnapshot() }).update()).toEqual({
      updated: false,
    });
  });
});

describe("AR-15 one revision per client", () => {
  it("a client keeps the revision it loaded first, even after an update", async () => {
    const { loader, publish } = swappableLoader(docsSnapshot("rev-1"));
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    const client = cms.forRelease();
    await client.resolve("SummerSEO");
    publish(docsSnapshot("rev-2"));
    expect(await cms.update()).toEqual({ updated: true });
    const [pages] = await client.list("page");
    expect(pages).toHaveLength(2);
    expect(await client.revision()).toBe("rev-1");
    expect(await cms.forRelease().revision()).toBe("rev-2");
  });
});

describe("AR-16 results are memoized per client", () => {
  it("an entry referenced three times runs once per client", async () => {
    const product = vi.fn((props: { slug: string }) => ({ slug: props.slug }));
    const content: Snapshot = {
      revision: "r",
      blocks: {
        Shirt: { __resolveType: "catalog-product", slug: "shirt" },
        Page: {
          __resolveType: "page",
          name: "P",
          path: "/p",
          sections: [
            { __resolveType: "Shirt" },
            { __resolveType: "Shirt" },
            { __resolveType: "Shirt" },
          ],
        },
      },
    };
    const cms = createCMS({ blocks: { "catalog-product": product }, content });
    await cms.forRelease().resolve("Page");
    expect(product).toHaveBeenCalledTimes(1);
    await cms.forRelease().resolve("Page");
    expect(product).toHaveBeenCalledTimes(2);
  });
});

describe("AR-17 clients are cheap: the content cache lives in the CMS", () => {
  it("ten clients load the content once", async () => {
    const { loader } = swappableLoader(docsSnapshot());
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    for (let i = 0; i < 10; i++) await cms.forRelease().resolve("SummerSEO");
    expect(loader.load).toHaveBeenCalledTimes(1);
  });
});

describe("AR-18 / AR-19 content: a snapshot or any loader", () => {
  it("accepts both; load() takes no argument, and a draft is layered over what it returned", async () => {
    const fromSnapshot = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    expect((await fromSnapshot.forRelease().resolve("SummerSEO"))[1]).toBeNull();

    const { pointer } = studioDraft();
    const load = vi.fn(async () => docsSnapshot());
    const cms = createCMS({ blocks: docsBlocks(), content: { load } });
    await cms.forRelease().resolve("SummerSEO");
    const [seo] = await cms.forDraft(pointer).resolve<{ title: string }>("SummerSEO");
    expect(seo?.title).toBe("Draft!");
    for (const call of load.mock.calls) expect(call).toEqual([]);
  });
});

describe("AR-22 remoteLoader", () => {
  it("is exported from the root, and is a loader over the fallback without site", async () => {
    expect(root.remoteLoader).toBe(remoteLoader);
    const fallback = docsSnapshot();
    expect(await remoteLoader(fallback, { site: "" }).load()).toBe(fallback);
  });

  it("createCMS builds it when site is set: update() reads latest.json from delivery.decocms.com", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request) => new Response("nope", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetch);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: { ...docsSnapshot(), schemaHash: "5".repeat(64) },
      site: "acme",
    });
    expect(await cms.update()).toEqual({ updated: false });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://delivery.decocms.com/sites/acme/latest.json",
    );
  });
});

describe("AR-24 / CT-08 update() runs in the background, never in front of a request", () => {
  it("a request doesn't wait on update(); the check is queued to the binding's background hook", async () => {
    captureBackground();
    let release!: () => void;
    const update = vi.fn(
      () =>
        new Promise<{ updated: boolean }>(
          (resolve) => (release = () => resolve({ updated: false })),
        ),
    );
    const cms = createCMS({
      blocks: docsBlocks(),
      content: { load: async () => docsSnapshot(), update },
    });
    const [seo] = await cms.forRelease().resolve("SummerSEO");
    expect(seo).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    const running = runBackground();
    expect(update).toHaveBeenCalledTimes(1);
    release();
    await running;
    // Not due again until the interval passes.
    await cms.forRelease().resolve("SummerSEO");
    expect(tasks).toHaveLength(0);
  });

  it("no framework binding: no v8 package depends on @decocms/tanstack or @decocms/nextjs", () => {
    // v8 sites depend on @decocms/blocks (and upstream clients) alone; on
    // Workers the core hands background work to waitUntil itself (ts-04).
    const packages = path.resolve(pkgRoot, "..");
    const offenders: string[] = [];
    for (const name of fs.readdirSync(packages)) {
      if (!/^(blocks|apps-.+)$/.test(name)) continue;
      const file = path.join(packages, name, "package.json");
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      const optional = manifest.peerDependenciesMeta ?? {};
      for (const binding of ["@decocms/tanstack", "@decocms/nextjs"]) {
        if (manifest.dependencies?.[binding]) offenders.push(`${name}: ${binding}`);
        if (manifest.peerDependencies?.[binding] && !optional[binding]?.optional) {
          offenders.push(`${name}: ${binding} (peer)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("AR-28 / AR-29 / AR-30 / CT-10 one instance per process", () => {
  it("same content module object -> same instance; different -> different", () => {
    const content = docsSnapshot();
    const a = createCMS({ blocks: docsBlocks(), content });
    expect(instanceOf(createCMS({ blocks: docsBlocks(), content }))).toBe(instanceOf(a));
    expect(
      instanceOf(createCMS({ blocks: docsBlocks(), content, site: "acme", token: "t" })),
    ).not.toBe(instanceOf(a));
  });

  it("a hot reload that hands in a new content module (new revision) keeps the instance", () => {
    // What `deco content` generates for the same .deco folder, before and after an edit.
    const before = { revision: "rev-1", blocks: {}, aliases: {}, root: "apps/site/.deco" };
    const after = { revision: "rev-2", blocks: {}, aliases: {}, root: "apps/site/.deco" };
    const a = createCMS({ blocks: {}, content: before });
    expect(instanceOf(createCMS({ blocks: {}, content: after }))).toBe(instanceOf(a));
  });

  it("the key is a Symbol.for('decocms.blocks…') on globalThis", () => {
    createCMS({ blocks: {}, content: docsSnapshot() });
    const keys = Object.getOwnPropertySymbols(globalThis)
      .map((s) => Symbol.keyFor(s))
      .filter((k) => k?.startsWith("decocms.blocks"));
    expect(keys.some((k) => k?.startsWith("decocms.blocks.cms:"))).toBe(true);
  });

  it("same key, different options: keeps the first and warns naming the option", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = docsSnapshot();
    const a = createCMS({ blocks: {}, content });
    expect(instanceOf(createCMS({ blocks: {}, content, interval: 120_000 }))).toBe(instanceOf(a));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("interval"));
  });

  it("resetForTests clears every stored instance", () => {
    const content = docsSnapshot();
    const a = createCMS({ blocks: {}, content });
    resetForTests();
    expect(createCMS({ blocks: {}, content })).not.toBe(a);
  });
});

describe("AR-31..AR-38 draft pointers", () => {
  it("parse and format round-trip the documented shape", () => {
    const p = { host: "api.deco.example", path: "/drafts/acme/main?token=abc", version: "9f3c1a" };
    const raw = formatDraftPointer(p);
    expect(raw).toBe("api.deco.example/drafts/acme/main?token=abc@9f3c1a");
    expect(parseDraftPointer(raw)).toEqual(p);
    expect(parseDraftPointer("localhost:8000/x@v1")).toEqual({
      host: "localhost:8000",
      path: "/x",
      version: "v1",
    });
  });

  it.each([
    null,
    undefined,
    "",
    "https://h/p@v",
    "h/p@v@x",
    "hp@v",
    "h!/p@v",
    "h/p@v v",
  ])("parseDraftPointer(%j) is null and never throws", (raw) => {
    expect(parseDraftPointer(raw as string | null | undefined)).toBeNull();
  });

  it("AR-34 the documented example, as written; parts that wouldn't parse throw", () => {
    expect(
      formatDraftPointer({
        host: "api.deco.example",
        path: "/drafts/acme/main?token=abc123",
        version: "9f3c1a",
      }),
    ).toBe("api.deco.example/drafts/acme/main?token=abc123@9f3c1a");
    expect(() =>
      formatDraftPointer({
        host: "api.deco.example",
        path: "/drafts/acme/main?token=…",
        version: "9f3c1a",
      }),
    ).toThrow();
  });

  it("AR-34 parse usage typechecks", () => {
    const errors = typecheck({
      "parse.ts": `
import { parseDraftPointer } from "@decocms/blocks";
declare const cookie: string | undefined;
const pointer = parseDraftPointer(cookie);
if (pointer) console.log(\`previewing \${pointer.version} from \${pointer.host}\`);
`,
    });
    expect(errors).toEqual([]);
  }, 60_000);

  it("AR-35 draftPointer: URL first, then the cookie; null for neither or ?__draft=off", async () => {
    const cookie = { cookie: `${DRAFT_COOKIE}=${encodeURIComponent("h/c@v1")}` };
    expect(await draftPointer(new Request("https://s/x?__draft=h/u@v1", { headers: cookie }))).toBe(
      "h/u@v1",
    );
    expect(await draftPointer(new Request("https://s/x", { headers: cookie }))).toBe("h/c@v1");
    expect(await draftPointer(new Request("https://s/x"))).toBeNull();
    expect(
      await draftPointer(new Request("https://s/x?__draft=off", { headers: cookie })),
    ).toBeNull();
  });

  it("AR-36 draftCookie: HttpOnly; Secure; SameSite=None; Partitioned; Path=/; off expires it; null otherwise", async () => {
    const set = await draftCookie(new Request("https://s/x?__draft=h/u@v1"));
    expect(set).toContain("__deco_draft=");
    for (const attribute of ["HttpOnly", "Secure", "SameSite=None", "Partitioned", "Path=/"]) {
      expect(set).toContain(attribute);
    }
    expect(set).not.toContain("SameSite=Lax");
    const off = await draftCookie(new Request("https://s/x?__draft=off"));
    expect(off).toMatch(/Max-Age=0|Expires=/);
    expect(await draftCookie(new Request("https://s/x"))).toBeNull();
    // An invalid ?__draft= gives null too.
    expect(await draftCookie(new Request("https://s/x?__draft=not-a-pointer"))).toBeNull();
  });

  it("AR-37 the helpers are CMS methods; the package root has no free draftPointer, draftCookie or DRAFT_COOKIE", () => {
    for (const name of ["draftPointer", "draftCookie", "DRAFT_COOKIE"]) {
      expect(Object.keys(root)).not.toContain(name);
    }
    const cms = helpers();
    expect(typeof cms.draftPointer).toBe("function");
    expect(typeof cms.draftCookie).toBe("function");
  });

  it("AR-38 both helpers take anything with url and headers", async () => {
    const like = { url: "https://s/x?__draft=h/u@v1", headers: new Headers() };
    expect(await draftPointer(like)).toBe("h/u@v1");
    expect(await draftCookie(like)).not.toBeNull();
  });
});

describe("AR-39..AR-45 client.resolve", () => {
  const client = () => createCMS({ blocks: docsBlocks(), content: docsSnapshot() }).forRelease();

  it("AR-40 resolve('SummerSEO') runs seo; { run: false } returns the saved block without running", async () => {
    const seoFn = vi.fn(seo);
    const cms = createCMS({ blocks: { ...docsBlocks(), seo: seoFn }, content: docsSnapshot() });
    expect(await cms.forRelease().resolve("SummerSEO", { run: false })).toEqual([
      { __resolveType: "seo", title: "Sunny!", description: "Light layers for long days." },
      null,
    ]);
    expect(seoFn).not.toHaveBeenCalled();
    expect(await cms.forRelease().resolve("SummerSEO")).toEqual([
      seo({ title: "Sunny!", description: "Light layers for long days." }),
      null,
    ]);
  });

  it("AR-41 / RT-04 resolve('SummerPage') returns the page with seo and sections resolved", async () => {
    expect(await client().resolve("SummerPage")).toEqual([
      {
        name: "Summer campaign",
        path: "/summer",
        seo: seo({ title: "Sunny!", description: "Light layers for long days." }),
        sections: [
          hero({ title: "Summer starts here", image: "https://cdn.example.com/summer.jpg" }),
        ],
      },
      null,
    ]);
  });

  it("AR-42 an inline block", async () => {
    const [value] = await client().resolve({ __resolveType: "seo", title: "Sale" });
    expect(value).toEqual({ title: "Sale" });
  });

  it("AR-43 / RN-05 an array of results; a hidden block is left out, and alone resolves to undefined with no error", async () => {
    const hidden = {
      __resolveType: "multivariate",
      variants: [
        {
          rule: { __resolveType: "never" },
          value: { __resolveType: "lazy", value: { __resolveType: "hero", title: "x" } },
        },
      ],
    };
    const c = client();
    const [results] = await c.resolve([{ __resolveType: "hero", title: "a" }, hidden]);
    expect(results).toEqual([hero({ title: "a" })]);
    expect(await c.resolve(hidden)).toEqual([undefined, null]);
  });

  it("AR-44 a value with no blocks comes back as is", async () => {
    const value = { title: "Store" };
    const [out] = await client().resolve(value);
    expect(out).toEqual(value);
  });

  it("AR-45 a string target is a saved block's name; unknown -> NOT_FOUND", async () => {
    const [value, error] = await client().resolve("Missing");
    expect(value).toBeNull();
    expect(error).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("AR-46..AR-49 client.list", () => {
  const content = (): Snapshot => ({
    revision: "r",
    blocks: {
      Zed: { __resolveType: "post", name: "Z", path: "/z", date: "2026-01-03" },
      Alpha: { __resolveType: "post", name: "A", path: "/a", date: "2026-01-01" },
      Old: { __resolveType: "article", name: "O", path: "/o", date: "2026-01-02" },
      Future: { __resolveType: "post", name: "F", path: "/f", date: "2999-01-01" },
      Other: { __resolveType: "seo", title: "t", description: "d" },
    },
    aliases: { article: "post" },
  });

  it("AR-46 lists the type and its aliases, sorted by name, without running", async () => {
    const post = vi.fn((p: unknown) => p);
    const cms = createCMS({ blocks: { post }, content: content() });
    const [entries] = await cms.forRelease().list<{ name: string }>("post");
    expect(entries?.map((e) => e.name)).toEqual(["A", "F", "O", "Z"]);
    expect(post).not.toHaveBeenCalled();
  });

  it("AR-47 run: true resolves each entry; an unknown block type is UNKNOWN_BLOCK; list('page', { run: true }) returns ready pages", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const [pages] = await cms.forRelease().list<{ seo?: unknown }>("page", { run: true });
    expect(pages?.find((p) => (p as { path: string }).path === "/summer")?.seo).toEqual(
      seo({ title: "Sunny!", description: "Light layers for long days." }),
    );
    const bad: Snapshot = {
      revision: "r",
      blocks: {
        P: { __resolveType: "page", name: "P", path: "/", sections: [{ __resolveType: "nope" }] },
      },
    };
    resetForTests();
    const [, error] = await createCMS({ blocks: {}, content: bad })
      .forRelease()
      .list("page", { run: true });
    expect(error?.code).toBe("UNKNOWN_BLOCK");
  });

  it("AR-48 / AR-49 where, sort and limit, as in the docs example", async () => {
    interface Post extends Route {
      date: string;
    }
    const cms = createCMS({ blocks: { post: (p: Post) => p }, content: content() });
    const today = new Date().toISOString().slice(0, 10);
    const [posts] = await cms.forRelease().list<Post>("post", {
      where: (p) => p.date <= today,
      sort: (a, b) => b.date.localeCompare(a.date),
      limit: 2,
    });
    expect(posts?.map((p) => p.name)).toEqual(["Z", "O"]);
  });
});

describe("AR-50..AR-52 / RT-03 / RT-07..RT-10 / RT-16 / RT-17 / RI-* matchRoute", () => {
  const route = (name: string, p: string) => ({ name, path: p });

  it("AR-50 takes (url, items) only, and redirects are the documented Redirect", () => {
    const source = readSource("src/v8/matchRoute.ts");
    const signature = /export function matchRoute[\s\S]*?\): Match<T>/.exec(source)?.[0] ?? "";
    expect(signature).not.toContain("options");
    expect(signature).not.toContain("LegacyRedirect");
  });

  it("accepts a string, a URL and a Request", () => {
    const routes = [route("Summer", "/summer")];
    for (const url of ["/summer", new URL("https://s/summer"), new Request("https://s/summer")]) {
      expect(matchRoute(url, { routes })).toMatchObject({ kind: "match", entry: routes[0] });
    }
  });

  it("AR-51 / RT-10 redirects win, exact beats template, the earlier entry wins; never throws", () => {
    const routes = [route("Tpl", "/:slug"), route("Exact", "/summer")];
    const redirects: Redirect[] = [{ from: "/summer", to: "/winter", permanent: false }];
    expect(matchRoute("/summer", { routes, redirects })).toEqual({
      kind: "redirect",
      location: "/winter",
      status: 302,
    });
    expect(matchRoute("/summer", { routes })).toMatchObject({ entry: { name: "Exact" } });
    expect(matchRoute("/x/p", { routes: [route("A", "/:slug/p"), route("B", "/:id/p")] })).toEqual({
      kind: "match",
      entry: { name: "A", path: "/:slug/p" },
      params: { slug: "x" },
    });
    for (const bad of ["", "::::", "http://", "%E0%A4%A", "/%"]) {
      expect(() => matchRoute(bad, { routes })).not.toThrow();
    }
  });

  it("AR-52 / RI-01 / RT-17 the trie is built once per routes array", () => {
    let builds = 0;
    const routes = new Proxy([route("A", "/a")], {
      get(target, prop, receiver) {
        if (prop === "filter") builds++;
        return Reflect.get(target, prop, receiver);
      },
    });
    matchRoute("/a", { routes });
    matchRoute("/a", { routes });
    expect(builds).toBe(1);
    matchRoute("/a", { routes: [route("A", "/a")] });
  });

  it("RT-03 status wins over permanent", () => {
    const redirects: Redirect[] = [{ from: "/a", to: "/b", permanent: true, status: 307 }];
    expect(matchRoute("/a", { routes: [], redirects })).toMatchObject({ status: 307 });
  });

  it("RT-07 / RT-16 the LegacyProduct redirect: params filled, query carried unless discarded", () => {
    const legacy: Redirect = {
      from: "/old-products/:slug",
      to: "/:slug/p",
      permanent: true,
    };
    expect(matchRoute("/old-products/summer", { routes: [], redirects: [legacy] })).toEqual({
      kind: "redirect",
      location: "/summer/p",
      status: 301,
    });
    expect(
      matchRoute("/old-products/summer?x=1", { routes: [], redirects: [legacy] }),
    ).toMatchObject({
      location: "/summer/p?x=1",
    });
    expect(
      matchRoute("/old-products/summer?x=1", {
        routes: [],
        redirects: [{ ...legacy, permanent: false, discardQueryParameters: true }],
      }),
    ).toEqual({ kind: "redirect", location: "/summer/p", status: 302 });
  });

  it("RT-09 /:slug/p matches /summer/p with params.slug", () => {
    expect(matchRoute("/summer/p", { routes: [route("Shirt", "/:slug/p")] })).toMatchObject({
      params: { slug: "summer" },
    });
  });

  it("RI-03 literal first, then parameter, with backtracking", () => {
    const routes = [route("Post", "/blog/:slug"), route("Archive", "/blog/archive")];
    expect(matchRoute("/blog/archive", { routes })).toMatchObject({ entry: { name: "Archive" } });
    expect(matchRoute("/blog/hello-world", { routes })).toMatchObject({ entry: { name: "Post" } });
    const back = [route("ABC", "/a/b/c"), route("XBD", "/:x/b/d")];
    expect(matchRoute("/a/b/d", { routes: back })).toEqual({
      kind: "match",
      entry: back[1],
      params: { x: "a" },
    });
  });

  it("RI-05 the URL is normalized; params are one segment", () => {
    const routes = [route("Root", "/"), route("Post", "/blog/:slug"), route("X", "/:x")];
    expect(matchRoute("/blog/hello%20world/?q=1#f", { routes })).toMatchObject({
      params: { slug: "hello world" },
    });
    expect(matchRoute("/", { routes })).toMatchObject({ entry: { name: "Root" } });
    expect(matchRoute("/a/b", { routes: [route("X", "/:x")] })).toEqual({ kind: "not-found" });
    expect(matchRoute("/a%2Fb", { routes: [route("X", "/:x")] })).toEqual({ kind: "not-found" });
  });

  it("RI-06 about a hundred lines, no regex, no sorting", () => {
    const source = readSource("src/v8/matchRoute.ts");
    const code = source.split("\n").filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*\*)/.test(l));
    expect(code.length).toBeLessThanOrEqual(150);
    expect(source).not.toMatch(/new RegExp|\.sort\(/);
    expect(source).not.toMatch(/\.(replace|search|split|test)\(\//);
  });

  it("RT-splat a trailing /* matches one or more segments, below exact and :params", () => {
    // routing.mdx › Path templates: `/docs/*` gets the rest in params["*"],
    // never zero segments; `/docs/setup` beats `/docs/:page` beats `/docs/*`.
    const splat = route("Splat", "/docs/*");
    const routes = [splat, route("Page", "/docs/:page"), route("Setup", "/docs/setup")];
    expect(matchRoute("/docs/guides/setup", { routes })).toMatchObject({
      entry: { name: "Splat" },
      params: { "*": "guides/setup" },
    });
    expect(matchRoute("/docs/setup", { routes })).toMatchObject({ entry: { name: "Setup" } });
    expect(matchRoute("/docs/intro", { routes })).toMatchObject({ entry: { name: "Page" } });
    expect(matchRoute("/docs", { routes })).toEqual({ kind: "not-found" });
    // `:rest*` is not syntax: it's one parameter named "rest*".
    expect(matchRoute("/a/b/c", { routes: [route("Rest", "/a/:rest*")] })).toEqual({
      kind: "not-found",
    });
  });

  it("RT-splat redirects copy the segments, still percent-encoded (no jump to another site)", () => {
    const redirects = [{ from: "/old-blog/*", to: "/blog/*", permanent: true }];
    expect(matchRoute("/old-blog/2024/hello", { routes: [], redirects })).toMatchObject({
      location: "/blog/2024/hello",
    });
    const toRoot = [{ from: "/old/*", to: "/*", permanent: true }];
    expect(matchRoute("/old/%2F%2Fevil.example", { routes: [], redirects: toRoot })).toMatchObject({
      location: "/%2F%2Fevil.example",
    });
  });
});

describe("AR-53 / AR-54 createInstrumentedFetch", () => {
  function recorder() {
    const histograms: { name: string; labels: Record<string, unknown> }[] = [];
    setCurrentTelemetry({
      histogram: (name: string, labels: Record<string, unknown>) =>
        histograms.push({ name, labels }),
      error: () => {},
      sampleTrace: () => false,
      span: () => {},
    } as unknown as TelemetryPipeline);
    return histograms;
  }

  it("no retry by default; retries when set and measures once with a retries label", async () => {
    const histograms = recorder();
    const statuses = [503, 503, 200];
    const upstream = vi.fn(async () => new Response("{}", { status: statuses.shift() ?? 200 }));
    const plain = createInstrumentedFetch({ provider: "acme", fetch: upstream });
    expect((await plain("https://u/x")).status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(1);

    const retried = createInstrumentedFetch({
      provider: "acme",
      fetch: upstream,
      retry: { attempts: 2, backoffMs: 1 },
    });
    expect((await retried("https://u/x", { operation: "search" })).status).toBe(200);
    expect(histograms).toHaveLength(2);
    expect(histograms[1]).toEqual({
      name: "http.client.request.duration",
      labels: {
        provider: "acme",
        operation: "search",
        status_class: "2xx",
        cached: false,
        retries: 1,
      },
    });
  });

  it("circuit breaker opens after N failures and recovers after the cooldown", async () => {
    recorder();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const upstream = vi.fn(async () => new Response("", { status: 500 }));
    const f = createInstrumentedFetch({
      provider: "acme",
      fetch: upstream,
      circuitBreaker: { failures: 2, cooldownMs: 1000 },
    });
    await f("https://u/x");
    await f("https://u/x");
    await expect(f("https://u/x")).rejects.toThrow(/circuit open/);
    expect(upstream).toHaveBeenCalledTimes(2);
    now += 1001;
    await f("https://u/x");
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("records nothing of bodies, headers or query strings", async () => {
    const histograms = recorder();
    const f = createInstrumentedFetch({
      provider: "acme",
      fetch: async () => new Response("secret-body"),
    });
    await f("https://u/x?token=abc", {
      headers: { cookie: "c=1" },
      body: "payload",
      method: "POST",
    });
    expect(JSON.stringify(histograms)).not.toMatch(/abc|c=1|payload|secret-body/);
  });

  it("nothing is measured without a destination", async () => {
    setCurrentTelemetry(undefined);
    const f = createInstrumentedFetch({ provider: "acme", fetch: async () => new Response("") });
    await expect(f("https://u/x")).resolves.toBeInstanceOf(Response);
  });
});

describe("AR-55 / AR-61 analytics", () => {
  it("AnalyticsScript renders the script, null when disabled; track is a no-op without it", () => {
    expect(AnalyticsScript({ enabled: false })).toBeNull();
    expect(isValidElement(AnalyticsScript({}))).toBe(true);
    expect(() => track("signup", { plan: "pro" })).not.toThrow();
  });

  it("the analytics section of cms.settings() fills the defaults", async () => {
    const cms = createCMS({ blocks: {}, content: { revision: "r", blocks: {} } });
    const { analytics } = await cms.settings();
    expect(analytics).toEqual({ collector: expect.stringMatching(/^https:\/\//), enabled: true });
  });
});

describe("AR-59 multivariate and lazy", () => {
  it("runs the first true variant; none -> undefined; lazy resolves once", async () => {
    const heavy = vi.fn((p: { n: number }) => p.n);
    const cms = createCMS({ blocks: { heavy }, content: { revision: "r", blocks: {} } });
    const c = cms.forRelease();
    const v = (rule: string, n: number) => ({
      rule: { __resolveType: rule },
      value: { __resolveType: "lazy", value: { __resolveType: "heavy", n } },
    });
    expect(
      await c.resolve({
        __resolveType: "multivariate",
        variants: [v("never", 0), v("always", 1), v("always", 2)],
      }),
    ).toEqual([1, null]);
    expect(heavy).toHaveBeenCalledTimes(1);
    expect(await c.resolve({ __resolveType: "multivariate", variants: [v("never", 3)] })).toEqual([
      undefined,
      null,
    ]);
    const lazyHolder = vi.fn(async (p: { later: () => Promise<number> }) => {
      await p.later();
      return p.later();
    });
    const cms2 = createCMS({
      blocks: { heavy, lazyHolder },
      content: { revision: "r2", blocks: {} },
    });
    heavy.mockClear();
    expect(
      await cms2.forRelease().resolve({
        __resolveType: "lazyHolder",
        later: { __resolveType: "lazy", value: { __resolveType: "heavy", n: 9 } },
      }),
    ).toEqual([9, null]);
    expect(heavy).toHaveBeenCalledTimes(1);
  });
});

describe("AR-60 the telemetry section: defaults and caps", () => {
  it("defaults 0.05 / 0, capped by limits", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        sent.push(String(url));
        return new Response("");
      }),
    );
    const pipeline = (limits?: { errorSampleRate?: number; traceSampleRate?: number }) =>
      new TelemetryPipeline(resolveDestination({ endpoint: "https://otel.example", limits })!);
    const random = vi.spyOn(Math, "random");

    // errorSampleRate 0.5 under the default limit 0.1: a draw of 0.2 is dropped, 0.09 kept.
    const capped = pipeline();
    capped.apply({ errorSampleRate: 0.5 });
    random.mockReturnValue(0.2);
    capped.error("e", {});
    await capped.flush();
    expect(sent.filter((u) => u.includes("/v1/logs"))).toHaveLength(0);
    random.mockReturnValue(0.09);
    capped.error("e", {});
    await capped.flush();
    expect(sent.filter((u) => u.includes("/v1/logs"))).toHaveLength(1);

    // Default errorSampleRate 0.05: 0.06 dropped.
    sent.length = 0;
    const defaults = pipeline({ errorSampleRate: 1 });
    defaults.apply({});
    random.mockReturnValue(0.06);
    defaults.error("e", {});
    await defaults.flush();
    expect(sent.filter((u) => u.includes("/v1/logs"))).toHaveLength(0);

    // traceSampleRate defaults to 0 and is capped at limit 0.
    random.mockReturnValue(0);
    const traces = pipeline();
    traces.apply({ traceSampleRate: 1 });
    expect(traces.sampleTrace()).toBe(false);
  });

  it("is always in the schema", () => {
    expect(readSource("src/v8/cli/schema/builtinSchemas.ts")).toMatch(
      /"cms-settings"[\s\S]*telemetry/,
    );
  });
});

describe("AR-63 nothing throws at request time", () => {
  it("a throwing block is a BLOCK_FAILED tuple", async () => {
    const cms = createCMS({
      blocks: {
        boom: () => {
          throw new Error("x");
        },
      },
      content: { revision: "r", blocks: {} },
    });
    const result = await cms.forRelease().resolve({ __resolveType: "boom" });
    expect(result[1]?.code).toBe("BLOCK_FAILED");
  });

  it("the one exception: client.revision() on a draft that can't load rejects with LOADER_FAILED", async () => {
    const cms = createCMS({ blocks: {}, content: { load: async () => docsSnapshot() } });
    await expect(cms.forDraft("garbage").revision()).rejects.toMatchObject({
      code: "LOADER_FAILED",
    });
  });
});

describe("AR-64 / AR-65 error codes and paths", () => {
  it("one case per code, with cause and path", async () => {
    const cause = new Error("upstream");
    const content: Snapshot = {
      revision: "r",
      blocks: {
        Unknown: { __resolveType: "nope" },
        A: { __resolveType: "B" },
        B: { __resolveType: "A" },
        Page: {
          __resolveType: "page",
          name: "P",
          path: "/p",
          sections: [
            { __resolveType: "hero", title: "1" },
            { __resolveType: "hero", title: "2" },
            { __resolveType: "card", product: { __resolveType: "product" } },
          ],
        },
      },
    };
    const cms = createCMS({
      blocks: {
        ...docsBlocks(),
        card: (p: unknown) => p,
        product: () => {
          throw cause;
        },
      },
      content,
    });
    const c = cms.forRelease();
    expect((await c.resolve("Missing"))[1]?.code).toBe("NOT_FOUND");
    expect((await c.resolve("Unknown"))[1]?.code).toBe("UNKNOWN_BLOCK");
    expect(
      (await c.resolve({ __resolveType: "page", name: "x", path: "/", sections: [] }))[1],
    ).toBeNull();
    expect((await c.resolve("A"))[1]?.code).toBe("CYCLE");
    const [, failed] = await c.resolve("Page");
    expect(failed).toMatchObject({ code: "BLOCK_FAILED", cause, path: ["sections", 2, "product"] });
    const [, loader] = await createCMS({
      blocks: {},
      content: {
        load: async () => {
          throw cause;
        },
      },
    })
      .forRelease()
      .resolve("x");
    expect(loader).toMatchObject({ code: "LOADER_FAILED", cause });
  });
});

// ---------------------------------------------------------------------------
// releases-and-drafts, routing, rendering
// ---------------------------------------------------------------------------

describe("RD-02 / RD-04 the draft client works like the release client", () => {
  it("forDraft reads the draft the pointer names; draftPointer picks the client", async () => {
    const { pointer } = studioDraft();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const pick = async (request: Request) => {
      const pointer = await cms.draftPointer(request);
      return pointer ? cms.forDraft(pointer) : cms.forRelease();
    };
    const link = `https://s/?__draft=${encodeURIComponent(pointer)}`;
    const [d] = await (await pick(new Request(link))).resolve<{
      title: string;
    }>("SummerSEO");
    expect(d?.title).toBe("Draft!");
    const [r] = await (await pick(new Request("https://s/"))).resolve<{ title: string }>(
      "SummerSEO",
    );
    expect(r?.title).toBe("Sunny!");
  });

  it("RD-04 snippet typechecks", () => {
    const errors = typecheck({
      "preview.ts": `
import { createCMS, type Snapshot } from "@decocms/blocks";
declare const content: Snapshot;
declare const request: Request;
const cms = createCMS({ blocks: {}, content });
const pointer = await cms.draftPointer(request);
const client = pointer ? cms.forDraft(pointer) : cms.forRelease();
export { client };
`,
    });
    expect(errors).toEqual([]);
  }, 60_000);
});

const MODEL_TS = `
import type { Block, Route, Seo } from "@decocms/blocks";

export interface PromoBannerProps { title: string; href: string; }
export interface ProductHeroProps { name: string; price: number; currency: string; image: string; }

export type BlockDescriptor =
  | { component: "promo-banner"; props: PromoBannerProps }
  | { component: "product-hero"; props: ProductHeroProps };

export interface StoredPage extends Route {
  seo?: Seo | Block;
  sections: Block[] | Block;
}

export interface ResolvedPage<T> extends Route { seo?: Seo; sections: T[]; }
`;
const POST_TS = `
import type { Route } from "@decocms/blocks";

export interface Post extends Route {
  /**
   * @title Published on
   * @format date
   */
  date: string;
  /** @format rich-text */
  body: string;
}
`;

describe("RT-14 / RT-11 / RT-13 the example project typechecks", () => {
  it("src/model.ts, src/post.ts, .deco/index.ts and the post index", () => {
    const errors = typecheck({
      "src/model.ts": MODEL_TS,
      "src/post.ts": POST_TS,
      ".deco/index.ts": `
import type { Blocks } from "@decocms/blocks";
import type { Post } from "../src/post";

const post = (props: Post) => props;
export default { post } satisfies Blocks;
`,
      "src/index-page.ts": `
import type { Client } from "@decocms/blocks";
import type { Post } from "./post";
declare const client: Client;
declare function link(path: string, name: string): void;
export async function index() {
  const [posts] = await client.list<Post>("post", { sort: (a, b) => b.date.localeCompare(a.date) });
  for (const post of posts!) link(post.path, post.name);
}
`,
    });
    expect(errors).toEqual([]);
  }, 60_000);
});

describe("RT-06 the route handler example", () => {
  it("typechecks as written", () => {
    const errors = typecheck({
      "src/model.ts": MODEL_TS,
      "src/post.ts": POST_TS,
      "src/handler.ts": `
import { matchRoute, type Client, type Redirect } from "@decocms/blocks";
import type { ReactNode } from "react";
import type { ResolvedPage, StoredPage } from "./model";
import type { Post } from "./post";
declare const cms: { forRelease(): Client };
declare function render(seo: unknown, sections: unknown): Response;
declare function renderPost(post: Post): Response;

export async function handle(request: Request): Promise<Response | undefined> {
  const client = cms.forRelease();
  const [pages]     = await client.list<StoredPage>("page");
  const [posts]     = await client.list<Post>("post");
  const [redirects] = await client.list<Redirect>("redirect");

  const match = matchRoute(request, { routes: [...pages!, ...posts!], redirects: redirects! });

  switch (match.kind) {
    case "not-found":
      return new Response("Not found", { status: 404 });
    case "redirect":
      return Response.redirect(new URL(match.location, request.url), match.status);
    case "match": {
      const entry = match.entry;
      if ("__resolveType" in entry && entry.__resolveType === "post") {
        return renderPost(entry as Post);
      }
      const [page] = await client.resolve<ResolvedPage<ReactNode>>(entry);
      return render(page!.seo, page!.sections);
    }
  }
}
`,
    });
    expect(errors).toEqual([]);
  }, 60_000);

  it("works end to end against the docs fixtures", async () => {
    const content = docsSnapshot();
    content.blocks.LegacyProduct = {
      __resolveType: "redirect",
      from: "/old-products/:slug",
      to: "/:slug/p",
      permanent: true,
    };
    const cms = createCMS({ blocks: docsBlocks(), content });
    const handle = async (request: Request) => {
      const client = cms.forRelease();
      const [pages] = await client.list<Route & { __resolveType: string }>("page");
      const [posts] = await client.list<Route & { __resolveType: string }>("post");
      const [redirects] = await client.list<Redirect>("redirect");
      const match = matchRoute(request, { routes: [...pages!, ...posts!], redirects: redirects! });
      switch (match.kind) {
        case "not-found":
          return { status: 404 };
        case "redirect":
          return { status: match.status, location: new URL(match.location, request.url).href };
        case "match":
          if (match.entry.__resolveType === "page") {
            const [page] = await client.resolve(match.entry);
            return { page };
          }
          return { post: match.entry };
      }
    };
    expect(await handle(new Request("https://s/campaigns/summer"))).toEqual({
      status: 301,
      location: "https://s/summer",
    });
    expect(await handle(new Request("https://s/old-products/summer"))).toEqual({
      status: 301,
      location: "https://s/summer/p",
    });
    expect(await handle(new Request("https://s/summer"))).toMatchObject({
      page: { name: "Summer campaign", seo: { title: "Sunny!" } },
    });
    expect(await handle(new Request("https://s/blog/hello-world"))).toMatchObject({
      post: { __resolveType: "post", name: "Hello, world" },
    });
    expect(await handle(new Request("https://s/nope"))).toEqual({ status: 404 });
  });
});

describe("RT-02 / RT-12 / RT-15 / RT-18 pages, data-only blocks", () => {
  it("a page saved without seo has seo undefined", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const [home] = await cms.forRelease().resolve<{ seo?: unknown }>("HomePage");
    expect(home?.seo).toBeUndefined();
  });

  it("a post resolves as saved; a menu is data only", async () => {
    const content: Snapshot = {
      revision: "r",
      blocks: {
        ...docsSnapshot().blocks,
        MainMenu: { __resolveType: "menu", items: ["a", "b"] },
      },
    };
    const cms = createCMS({
      blocks: { ...docsBlocks(), menu: (props: { items: string[] }) => props },
      content,
    });
    const c = cms.forRelease();
    const [post] = await c.resolve(content.blocks.HelloWorld);
    const { __resolveType: _t, ...saved } = content.blocks.HelloWorld as Record<string, unknown>;
    expect(post).toEqual(saved);
    expect(await c.resolve("MainMenu")).toEqual([{ items: ["a", "b"] }, null]);
  });

  it("list('page') returns a whole-list multivariate sections block unrun", async () => {
    const sections = {
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "always" }, value: { __resolveType: "lazy", value: [] } },
      ],
    };
    const cms = createCMS({
      blocks: {},
      content: {
        revision: "r",
        blocks: { P: { __resolveType: "page", name: "P", path: "/", sections } },
      },
    });
    const [pages] = await cms.forRelease().list<{ sections: unknown }>("page");
    expect(pages?.[0]?.sections).toEqual(sections);
  });
});

describe("RN-01 / RN-02 / RN-06 rendering", () => {
  it("returns whatever the block function returns, unmodified", async () => {
    const element = { $$typeof: Symbol.for("react.transitional.element"), type: "div", props: {} };
    const descriptor = { component: "promo-banner", props: { title: "t" } };
    const cms = createCMS({
      blocks: { el: () => element, desc: () => descriptor },
      content: { revision: "r", blocks: {} },
    });
    const c = cms.forRelease();
    expect((await c.resolve({ __resolveType: "el" }))[0]).toBe(element);
    expect((await c.resolve({ __resolveType: "desc" }))[0]).toBe(descriptor);
  });

  it("RN-02 both block-map styles typecheck", () => {
    const errors = typecheck({
      "src/model.ts": MODEL_TS,
      "src/PromoBanner.tsx": `
import type { PromoBannerProps } from "./model";
export default function PromoBanner(props: PromoBannerProps) { return <a href={props.href}>{props.title}</a>; }
`,
      ".deco/index.tsx": `
import type { Blocks } from "@decocms/blocks";
import PromoBanner from "../src/PromoBanner";
import type { PromoBannerProps } from "../src/model";
export const rsc = { "promo-banner": (input: PromoBannerProps) => <PromoBanner {...input} /> } satisfies Blocks;
export const data = { "promo-banner": (input: PromoBannerProps) => ({ component: "promo-banner", props: input }) } satisfies Blocks;
const views = { "promo-banner": PromoBanner };
export { views };
`,
    });
    expect(errors).toEqual([]);
  }, 60_000);

  it("RN-06 resolution never sees the request: no requestScope, no Request/signal in createCMS or Client; only the draft helpers read one", () => {
    const r = root as Record<string, unknown>;
    expect(Object.keys(r).filter((k) => /requestScope/i.test(k))).toEqual([]);
    expect(Object.keys(v8).filter((k) => /request/i.test(k))).toEqual([]);
    const types = readSource("src/v8/types.ts");
    const section = (start: string) => {
      const from = types.indexOf(start);
      return types.slice(from, types.indexOf("\n}\n", from));
    };
    expect(section("export interface CMSConfig")).not.toMatch(/Request|signal/);
    expect(section("export interface Client")).not.toMatch(/Request|signal/);
    const cmsMethods = section("export interface CMS {")
      .split("\n")
      .filter((line) => /^\s{2}\w+\(/.test(line) && /Request|signal/.test(line));
    expect(cmsMethods.map((line) => line.trim().split("(")[0])).toEqual([
      "draftPointer",
      "draftCookie",
    ]);
  });
});

// Keep `Blocks` referenced for readers grepping the doc's type names.
export type { Blocks };
