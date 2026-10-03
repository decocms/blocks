// @vitest-environment node
/**
 * Conformance: the docs (blocks-site docs/content/next: api-reference,
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
import * as fetchModule from "../fetch";
import { createInstrumentedFetch } from "../fetch";
import * as v8 from "../index";
import {
  createCMS,
  DRAFT_COOKIE,
  draftCookie,
  draftPointer,
  formatDraftPointer,
  matchRoute,
  parseDraftPointer,
  remoteLoader,
  resetForTests,
} from "../index";
import * as secretsModule from "../secrets";
import { encryptSecret } from "../secrets";
import { resolveDestination, setCurrentTelemetry, TelemetryPipeline } from "../telemetry";
import { docsBlocks, docsSnapshot, hero, seo } from "../testFixtures";
import type { Blocks, Loader, Redirect, Route, Snapshot } from "../types";
import { typecheck } from "./typecheck";

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
  "DRAFT_COOKIE",
  "createCMS",
  "draftCookie",
  "draftPointer",
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
    const names = exportedNames(readSource("src/index.ts"), "./v8/index");
    expect(names).toEqual([...DOCUMENTED_ROOT_VALUES, ...DOCUMENTED_ROOT_TYPES].sort());
  });
});

describe("AR-02 fetch, analytics and secrets live on their own subpaths", () => {
  it("package.json maps the subpaths to the v8 modules", () => {
    const pkg = JSON.parse(readSource("package.json"));
    expect(pkg.exports["./fetch"]).toBe("./src/v8/fetch.ts");
    expect(pkg.exports["./analytics"]).toBe("./src/v8/analytics.ts");
    expect(pkg.exports["./secrets"]).toBe("./src/v8/secrets.ts");
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
  type Redirect, type Secret, type Lazy, type Variant, type TelemetryConfig, type Telemetry, type Analytics } from "@decocms/blocks";
import type { ReactNode } from "react";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assert = <T extends true>() => {};

declare const blocks: Blocks;
declare const content: Snapshot;
declare const loader: Loader;
createCMS({ blocks, content });
createCMS({ blocks, content: loader, interval: 60_000, telemetry: false, secrets: { key: "k" }, site: "s", token: "t" });
createCMS({ blocks, content, telemetry: { site: "s", token: "t", limits: { errorSampleRate: 0.1, traceSampleRate: 0 } } });
createCMS({ blocks, content, telemetry: { endpoint: "https://otel.example", headers: { a: "b" } } });
// @ts-expect-error not a documented option
createCMS({ blocks, content, ignoreCase: true });

assert<Equal<keyof CMS, "forRelease" | "forDraft" | "forRevision" | "update">>();
assert<Equal<CMS["forDraft"], (pointer: string) => Client>>();
assert<Equal<CMS["forRevision"], (revision: string) => Client>>();
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
assert<Equal<Loader["load"], (pointer?: string | null) => Promise<Snapshot>>>();
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
assert<Equal<TelemetryConfig, ({ site: string; token: string } | { endpoint: string; headers?: Record<string, string> }) & { limits?: { errorSampleRate?: number; traceSampleRate?: number } }>>();
export { r1, r2, r3 };
`,
    });
    expect(errors).toEqual([]);
  }, 60_000);

  it("AR-57 Snapshot is exactly { revision, blocks, aliases? }", () => {
    const errors = typecheck({
      "snapshot.ts": `
import type { Snapshot } from "@decocms/blocks";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assert = <T extends true>() => {};
assert<Equal<Snapshot, { revision: string; blocks: Record<string, unknown>; aliases?: Record<string, string> }>>();
`,
    });
    expect(errors).toEqual([]);
  }, 60_000);
});

describe("AR-05 interval: default DECO_CONTENT_INTERVAL or 60 000, minimum 60 000", () => {
  const intervalOf = (cms: unknown) =>
    (cms as { fingerprint: { interval: number } }).fingerprint.interval;

  it("clamps a value below the minimum", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cms = createCMS({ blocks: {}, content: docsSnapshot(), interval: 1000 });
    expect(intervalOf(cms)).toBe(60_000);
  });

  it("defaults to 60 000 and reads DECO_CONTENT_INTERVAL", () => {
    expect(intervalOf(createCMS({ blocks: {}, content: docsSnapshot() }))).toBe(60_000);
    resetForTests();
    vi.stubEnv("DECO_CONTENT_INTERVAL", "120000");
    expect(intervalOf(createCMS({ blocks: {}, content: docsSnapshot() }))).toBe(120_000);
  });

  it("clamps DECO_CONTENT_INTERVAL below the minimum too", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("DECO_CONTENT_INTERVAL", "5000");
    expect(intervalOf(createCMS({ blocks: {}, content: docsSnapshot() }))).toBe(60_000);
  });
});

describe("AR-06 / AR-07 telemetry destination and limits", () => {
  it("limits default to 0.1 and 0", () => {
    expect(resolveDestination({ endpoint: "https://otel.example" })?.limits).toEqual({
      errorSampleRate: 0.1,
      traceSampleRate: 0,
    });
    expect(resolveDestination({ site: "s", token: "t" })?.limits).toEqual({
      errorSampleRate: 0.1,
      traceSampleRate: 0,
    });
  });

  it("false sends nothing, even with OTEL_EXPORTER_OTLP_ENDPOINT set", () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://env.example");
    expect(resolveDestination(false)).toBeNull();
  });

  it("an object sends there", () => {
    expect(
      resolveDestination({ endpoint: "https://otel.example", headers: { a: "b" } }),
    ).toMatchObject({ endpoint: "https://otel.example", headers: { a: "b" } });
  });

  it("omitted: OTEL_EXPORTER_OTLP_ENDPOINT and _HEADERS when set, otherwise nothing", () => {
    expect(resolveDestination(undefined)).toBeNull();
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://env.example");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "x-key=abc");
    expect(resolveDestination(undefined)).toMatchObject({
      endpoint: "https://env.example",
      headers: { "x-key": "abc" },
    });
  });
});

describe("AR-08 site and token load hosted content only, never telemetry", () => {
  it("site without token: the content is read as is (no hosted loader, no fetch)", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: "acme" });
    const [seo] = await cms.forDraft("delivery.decocms.com/drafts/acme/x@v1").resolve("SummerSEO");
    expect(seo).toEqual({ title: "Sunny!", description: "Light layers for long days." });
    expect(await cms.update()).toEqual({ updated: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("site and token with telemetry omitted and no OTEL env: no telemetry", async () => {
    const { currentTelemetry } = await import("../telemetry");
    createCMS({ blocks: docsBlocks(), content: docsSnapshot(), site: "acme", token: "t" });
    expect(currentTelemetry()).toBeUndefined();
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
  it("a snapshot source ignores the pointer: forDraft reads the release", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    const draft = cms.forDraft("api.deco.example/drafts/acme/main@9f3c1a");
    expect(await draft.resolve("SummerSEO")).toEqual(await cms.forRelease().resolve("SummerSEO"));
    expect(await draft.revision()).toBe("rev-1");
  });

  it("a draft whose load(pointer) fails makes every call return LOADER_FAILED with the cause", async () => {
    const cause = new Error("storage down");
    const loader: Loader = {
      load: async (pointer) => {
        if (pointer) throw cause;
        return docsSnapshot();
      },
    };
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    const client = cms.forDraft("api.deco.example/drafts/acme/main@9f3c1a");
    const [value, error] = await client.resolve("SummerSEO");
    expect(value).toBeNull();
    expect(error).toMatchObject({ code: "LOADER_FAILED", cause });
    const [list, listError] = await client.list("page");
    expect(list).toBeNull();
    expect(listError?.code).toBe("LOADER_FAILED");
  });

  it("a pointer that doesn't parse makes every call return LOADER_FAILED; load(pointer) is never called", async () => {
    const load = vi.fn(async () => docsSnapshot());
    const cms = createCMS({ blocks: docsBlocks(), content: { load } });
    const client = cms.forDraft("garbage");
    expect((await client.resolve("SummerSEO"))[1]?.code).toBe("LOADER_FAILED");
    expect((await client.list("page"))[1]?.code).toBe("LOADER_FAILED");
    expect(load).not.toHaveBeenCalledWith("garbage");
  });

  it("a snapshot source has no scheduled checks", async () => {
    captureBackground();
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    await cms.forRelease().resolve("SummerSEO");
    expect(tasks).toHaveLength(0);
    expect(await cms.update()).toEqual({ updated: false });
  });
});

describe("AR-12 forRevision", () => {
  it("pins a served revision; an unknown revision reads the release", async () => {
    const { loader, publish } = swappableLoader(docsSnapshot("rev-1"));
    const cms = createCMS({ blocks: docsBlocks(), content: loader });
    const old = await cms.forRelease().revision();
    const next = docsSnapshot("rev-2");
    (next.blocks.SummerSEO as { title: string }).title = "New";
    publish(next);
    expect(await cms.update()).toEqual({ updated: true });
    expect(await cms.forRelease().revision()).toBe("rev-2");
    const [pinned] = await cms.forRevision(old).resolve<{ title: string }>("SummerSEO");
    expect(pinned?.title).toBe("Sunny!");
    expect(await cms.forRevision("nope").revision()).toBe("rev-2");
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
  it("accepts both; load() for the release, load(pointer) for a draft", async () => {
    const fromSnapshot = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    expect((await fromSnapshot.forRelease().resolve("SummerSEO"))[1]).toBeNull();

    const load = vi.fn(async (_pointer?: string | null) => docsSnapshot());
    const cms = createCMS({ blocks: docsBlocks(), content: { load } });
    await cms.forRelease().resolve("SummerSEO");
    expect(load).toHaveBeenLastCalledWith();
    const pointer = "api.deco.example/drafts/acme/main@9f3c1a";
    await cms.forDraft(pointer).resolve("SummerSEO");
    expect(load).toHaveBeenLastCalledWith(pointer);
  });
});

describe("AR-22 remoteLoader", () => {
  it("is exported from the root, and returns the fallback unchanged without site or token", () => {
    expect(root.remoteLoader).toBe(remoteLoader);
    const fallback = docsSnapshot();
    expect(remoteLoader(fallback, { site: "", token: "" })).toBe(fallback);
  });

  it("createCMS builds it when site and token are set: forDraft reaches the Deco API", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      site: "acme",
      token: "t",
    });
    const [, error] = await cms
      .forDraft("delivery.decocms.com/drafts/acme/x@v1")
      .resolve("SummerSEO");
    expect(error?.code).toBe("LOADER_FAILED");
    expect(fetch).toHaveBeenCalled();
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

  it("the TanStack worker entry runs due checks after the response inside ctx.waitUntil", () => {
    const workerEntry = fs.readFileSync(
      path.resolve(pkgRoot, "../tanstack/src/sdk/workerEntry.ts"),
      "utf8",
    );
    expect(workerEntry).toContain("installBackgroundHook()");
    expect(workerEntry).toContain("runBackgroundTasks(ctx)");
  });
});

describe("AR-28 / AR-29 / AR-30 / CT-10 one instance per process", () => {
  it("same content module object -> same instance; different -> different", () => {
    const content = docsSnapshot();
    const a = createCMS({ blocks: docsBlocks(), content });
    expect(createCMS({ blocks: docsBlocks(), content })).toBe(a);
    expect(createCMS({ blocks: docsBlocks(), content, site: "acme", token: "t" })).not.toBe(a);
  });

  it("a hot reload that hands in a new content module (new revision) keeps the instance", () => {
    // What `deco content` generates for the same .deco folder, before and after an edit.
    const before = { revision: "rev-1", blocks: {}, aliases: {}, root: "apps/site/.deco" };
    const after = { revision: "rev-2", blocks: {}, aliases: {}, root: "apps/site/.deco" };
    const a = createCMS({ blocks: {}, content: before });
    expect(createCMS({ blocks: {}, content: after })).toBe(a);
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
    expect(createCMS({ blocks: {}, content, interval: 120_000 })).toBe(a);
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

  it("AR-34 the documented example, as written", () => {
    expect(
      formatDraftPointer({
        host: "api.deco.example",
        path: "/drafts/acme/main?token=…",
        version: "9f3c1a",
      }),
    ).toBe("api.deco.example/drafts/acme/main?token=…@9f3c1a");
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

  it("AR-35 draftPointer: URL first, then the cookie; null for neither or ?__draft=off", () => {
    const cookie = { cookie: `${DRAFT_COOKIE}=${encodeURIComponent("h/c@v1")}` };
    expect(draftPointer(new Request("https://s/x?__draft=h/u@v1", { headers: cookie }))).toBe(
      "h/u@v1",
    );
    expect(draftPointer(new Request("https://s/x", { headers: cookie }))).toBe("h/c@v1");
    expect(draftPointer(new Request("https://s/x"))).toBeNull();
    expect(draftPointer(new Request("https://s/x?__draft=off", { headers: cookie }))).toBeNull();
  });

  it("AR-36 draftCookie: HttpOnly, SameSite=Lax, Path=/; off expires it; null otherwise", () => {
    const set = draftCookie(new Request("https://s/x?__draft=h/u@v1"));
    expect(set).toContain("deco-draft=");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/");
    const off = draftCookie(new Request("https://s/x?__draft=off"));
    expect(off).toMatch(/Max-Age=0|Expires=/);
    expect(draftCookie(new Request("https://s/x"))).toBeNull();
  });

  it("AR-37 DRAFT_COOKIE is deco-draft", () => {
    expect(DRAFT_COOKIE).toBe("deco-draft");
  });

  it("AR-38 both helpers take anything with url and headers", () => {
    const like = { url: "https://s/x?__draft=h/u@v1", headers: new Headers() };
    expect(draftPointer(like)).toBe("h/u@v1");
    expect(draftCookie(like)).not.toBeNull();
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

  it("only documented path syntax: literal segments and :params (no splats)", () => {
    // `*` and `:rest*` match the remaining segments: undocumented.
    expect(matchRoute("/a/b/c", { routes: [route("Splat", "/a/*")] })).toEqual({
      kind: "not-found",
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

  it("the analytics block fills the defaults", async () => {
    const cms = createCMS({ blocks: {}, content: { revision: "r", blocks: {} } });
    const [value] = await cms.forRelease().resolve({ __resolveType: "analytics" });
    expect(value).toEqual({ collector: expect.stringMatching(/^https:\/\//), enabled: true });
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

describe("AR-60 the Telemetry block: defaults and caps", () => {
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
    const withBlock = (block: Record<string, unknown>): Snapshot => ({
      revision: `r-${JSON.stringify(block)}`,
      blocks: { Telemetry: { __resolveType: "telemetry", ...block } },
    });
    const random = vi.spyOn(Math, "random");

    // errorSampleRate 0.5 under the default limit 0.1: a draw of 0.2 is dropped, 0.09 kept.
    const capped = pipeline();
    capped.useRelease(withBlock({ errorSampleRate: 0.5 }));
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
    defaults.useRelease({ revision: "none", blocks: {} });
    random.mockReturnValue(0.06);
    defaults.error("e", {});
    await defaults.flush();
    expect(sent.filter((u) => u.includes("/v1/logs"))).toHaveLength(0);

    // traceSampleRate defaults to 0 and is capped at limit 0.
    random.mockReturnValue(0);
    const traces = pipeline();
    traces.useRelease(withBlock({ traceSampleRate: 1 }));
    expect(traces.sampleTrace()).toBe(false);
  });

  it("is always in the schema", () => {
    expect(readSource("src/v8/cli/schema/builtinSchemas.ts")).toMatch(/telemetry/);
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

  it("client.revision() on a draft that can't load doesn't reject", async () => {
    const cms = createCMS({ blocks: {}, content: { load: async () => docsSnapshot() } });
    await expect(cms.forDraft("garbage").revision()).resolves.toBeDefined();
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
  it("forDraft passes the pointer to load(pointer); draftPointer picks the client", async () => {
    const draft = docsSnapshot("draft-1");
    (draft.blocks.SummerSEO as { title: string }).title = "Draft!";
    const load = vi.fn(async (pointer?: string | null) => (pointer ? draft : docsSnapshot()));
    const cms = createCMS({ blocks: docsBlocks(), content: { load } });
    const pick = (request: Request) => {
      const pointer = draftPointer(request);
      return pointer ? cms.forDraft(pointer) : cms.forRelease();
    };
    const pointer = "api.deco.example/drafts/acme/main@9f3c1a";
    const [d] = await pick(new Request(`https://s/?__draft=${pointer}`)).resolve<{ title: string }>(
      "SummerSEO",
    );
    expect(load).toHaveBeenCalledWith(pointer);
    expect(d?.title).toBe("Draft!");
    const [r] = await pick(new Request("https://s/")).resolve<{ title: string }>("SummerSEO");
    expect(r?.title).toBe("Sunny!");
  });

  it("RD-04 snippet typechecks", () => {
    const errors = typecheck({
      "preview.ts": `
import { createCMS, draftPointer, type Snapshot } from "@decocms/blocks";
declare const content: Snapshot;
declare const request: Request;
const cms = createCMS({ blocks: {}, content });
const pointer = draftPointer(request);
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
    case "match":
      switch (match.entry.__resolveType) {
        case "page": {
          const [page] = await client.resolve<ResolvedPage<ReactNode>>(match.entry);
          return render(page!.seo, page!.sections);
        }
        case "post":
          return renderPost(match.entry);
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

  it("RN-06 the SDK never sees the request: no requestScope, no Request/signal in createCMS or Client", () => {
    const r = root as Record<string, unknown>;
    expect(Object.keys(r).filter((k) => /requestScope/i.test(k))).toEqual([]);
    expect(Object.keys(v8).filter((k) => /request/i.test(k))).toEqual([]);
    const types = readSource("src/v8/types.ts");
    const cmsAndClient = types.slice(types.indexOf("export interface Client"));
    expect(cmsAndClient).not.toMatch(/Request|signal/);
  });
});

// Keep `Blocks` referenced for readers grepping the doc's type names.
export type { Blocks };
