/**
 * Test-only: an in-process fake of the Studio content API
 * (`/api/cms/<site>/…`, contract §4) and of the public CDN
 * (`/cdn/sites/<site>/…` in the content-addressed layout: `latest.json` as
 * the revision index, `blocks/<hash>.json`, draft folders) on one real HTTP server, so the CLI's
 * remote commands run black-box over the network. It keeps the protocol's
 * rules that the CLI depends on: `ifMatch` against the draft only, the
 * conflict payload from the save's own read, all-or-nothing saves, and
 * publish as latest ⊕ draft, and the content handler's caps on one
 * `blocks.apply` (names per call, bytes per block). Failures are injected
 * per route.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { blockVersion } from "../../../protocol/canonical";
import { serializeBlock } from "../../../protocol/keys";
import { MAX_BLOCK_BYTES, MAX_OPS_PER_APPLY } from "../../../protocol/server/core";
import { TOMBSTONE_VERSION } from "../../../protocol/storage";
import { indexEntry } from "../../blockMeta";

export const SITE = "store";
export const TOKEN = "tok_test";
export const USER = "usr_me";

type Blocks = Record<string, unknown>;

export interface FakeDraft {
  name: string;
  slug: string;
  createdBy: string;
  via: string;
  createdAt: string;
  /** `null` until the object exists. */
  etag: string | null;
  body: { set: Blocks; delete: string[]; editors: Record<string, { userId: string; at: number }> };
}

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** An injected answer: the status and JSON body to answer with, once or always. */
export interface Injected {
  status: number;
  json?: unknown;
  /** Answer this many times (default 1), then behave normally. */
  times?: number;
  /** Close the connection instead of answering. */
  destroy?: boolean;
  /** Let this many matching requests through first (default 0). */
  after?: number;
}

const MAX48 = 2n ** 48n - 1n;
let lastMs = 0;

/** A revision id as Studio mints them (contract §1.2), strictly newer each call. */
export function newRevisionId(): string {
  const nowMs = Math.max(Date.now(), lastMs + 1);
  lastMs = nowMs;
  const b = new Uint8Array(16);
  let t = BigInt(nowMs);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  b.set(randomBytes(10), 6);
  b[6] = 0x70 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return `${(MAX48 - BigInt(nowMs)).toString(16).padStart(12, "0")}-${uuid}`;
}

function map(record: Blocks = {}): Blocks {
  const out: Blocks = Object.create(null);
  for (const [k, v] of Object.entries(record)) out[k] = v;
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface FakeStudio {
  /** `DECO_STUDIO_URL`. */
  studioUrl: string;
  /** `DECO_DELIVERY_URL`. */
  deliveryUrl: string;
  /** The env a CLI run needs: both URLs and the token. */
  env: Record<string, string>;
  requests: Recorded[];
  revisions: Map<string, { blocks: Blocks; meta: Record<string, unknown>; sequence: number }>;
  latest: string | null;
  drafts: Map<string, FakeDraft>;
  schema: string | null;
  /** Injected answers by `"<METHOD> <path suffix>"`, e.g. `"POST /drafts/x/rpc"`, or `"CDN"`. */
  inject: Map<string, Injected[]>;
  /** Sets production to a new revision with these blocks; returns its id. */
  release(blocks: Blocks, meta?: Record<string, unknown>): string;
  /** Runs once before the next `blocks.apply` is handled: another save racing a push. */
  beforeApply: (() => Promise<void>) | null;
  /** Saves into a draft as another person would, creating it if needed. */
  save(name: string, set: Blocks, deleted?: string[], userId?: string): Promise<void>;
  close(): Promise<void>;
}

export async function startFakeStudio(): Promise<FakeStudio> {
  const state = {
    requests: [] as Recorded[],
    revisions: new Map<
      string,
      { blocks: Blocks; meta: Record<string, unknown>; sequence: number }
    >(),
    latest: null as string | null,
    drafts: new Map<string, FakeDraft>(),
    schema: null as string | null,
    inject: new Map<string, Injected[]>(),
  };
  let etagCounter = 0;
  const nextEtag = () => `etag${++etagCounter}`;

  const ensure = (name: string, via = "cli"): { draft: FakeDraft; created: boolean } => {
    const existing = state.drafts.get(name);
    if (existing) return { draft: existing, created: false };
    const draft: FakeDraft = {
      name,
      slug: randomBytes(16).toString("base64url"),
      createdBy: USER,
      via,
      createdAt: new Date().toISOString(),
      etag: nextEtag(),
      body: { set: map(), delete: [], editors: {} },
    };
    state.drafts.set(name, draft);
    return { draft, created: true };
  };

  /** A revision's index, as Studio writes `revisions/<id>/index.json` and `latest.json`. */
  const indexOf = async (id: string) => {
    const r = state.revisions.get(id)!;
    const names = Object.keys(r.blocks);
    const blocks: Record<string, unknown> = {};
    for (const name of names) blocks[name] = await indexEntry(name, r.blocks[name], names);
    return { revision: id, sequence: r.sequence, blocks };
  };

  const draftAnswer = (draft: FakeDraft) => {
    const pointer = draft.etag
      ? `delivery.test/sites/${SITE}/drafts/${draft.slug}/index.json@${draft.etag}`
      : null;
    return {
      name: draft.name,
      slug: draft.slug,
      createdBy: draft.createdBy,
      via: draft.via,
      createdAt: draft.createdAt,
      etag: draft.etag,
      pointer,
      previewUrl: pointer ? `https://www.store.test/?__draft=${encodeURIComponent(pointer)}` : null,
    };
  };

  const versionIn = async (draft: FakeDraft, name: string): Promise<string | null> => {
    if (Object.hasOwn(draft.body.set, name)) return blockVersion(draft.body.set[name]);
    if (draft.body.delete.includes(name)) return TOMBSTONE_VERSION;
    return null;
  };

  const applyTo = async (
    draft: FakeDraft,
    params: { set?: Blocks; delete?: string[]; ifMatch?: Record<string, string | null> },
    userId: string,
  ) => {
    const set = map(params.set);
    const deleted = params.delete ?? [];
    const ifMatch = params.ifMatch ?? {};
    // The real handler's guards (protocol/server/methods/apply.ts).
    const ops = Object.keys(set).length + deleted.filter((n) => !Object.hasOwn(set, n)).length;
    if (ops > MAX_OPS_PER_APPLY) {
      return { error: { code: -32007, message: `${ops} names in one blocks.apply` } };
    }
    for (const [name, block] of Object.entries(set)) {
      if (Buffer.byteLength(serializeBlock(block)) > MAX_BLOCK_BYTES) {
        return { error: { code: -32003, message: `"${name}" is over ${MAX_BLOCK_BYTES} bytes` } };
      }
    }
    const entries: Record<string, { expected: string | null; actual: string | null }> = {};
    const conflictDraft: Record<string, unknown> = {};
    for (const name of [...Object.keys(set), ...deleted]) {
      if (!Object.hasOwn(ifMatch, name)) {
        return { error: { code: -32602, message: `no ifMatch for "${name}"` } };
      }
      const actual = await versionIn(draft, name);
      if (actual !== ifMatch[name]) {
        entries[name] = { expected: ifMatch[name] ?? null, actual };
        const editor = draft.body.editors[name] ?? null;
        conflictDraft[name] = Object.hasOwn(draft.body.set, name)
          ? { block: draft.body.set[name], version: actual, editor }
          : draft.body.delete.includes(name)
            ? { block: null, version: TOMBSTONE_VERSION, editor }
            : null;
      }
    }
    if (Object.keys(entries).length > 0) {
      return {
        error: {
          code: -32002,
          message: "a precondition failed",
          data: { entries, draft: conflictDraft },
        },
      };
    }
    const at = Math.floor(Date.now() / 1000);
    const versions: Record<string, string | null> = {};
    for (const [name, block] of Object.entries(set)) {
      draft.body.set[name] = block;
      draft.body.delete = draft.body.delete.filter((n) => n !== name);
      draft.body.editors[name] = { userId, at };
      versions[name] = await blockVersion(block);
    }
    for (const name of deleted) {
      delete draft.body.set[name];
      if (!draft.body.delete.includes(name)) draft.body.delete.push(name);
      draft.body.editors[name] = { userId, at };
      versions[name] = TOMBSTONE_VERSION;
    }
    draft.etag = nextEtag();
    return { result: { revision: draft.etag, versions } };
  };

  const fake: FakeStudio = {
    beforeApply: null,
    studioUrl: "",
    deliveryUrl: "",
    env: {},
    get requests() {
      return state.requests;
    },
    get revisions() {
      return state.revisions;
    },
    get latest() {
      return state.latest;
    },
    set latest(value) {
      state.latest = value;
    },
    get drafts() {
      return state.drafts;
    },
    get schema() {
      return state.schema;
    },
    set schema(value) {
      state.schema = value;
    },
    get inject() {
      return state.inject;
    },
    release(blocks, meta = {}) {
      const id = newRevisionId();
      state.revisions.set(id, {
        sequence: state.revisions.size + 1,
        blocks: map(blocks),
        meta: {
          previous: state.latest,
          author: USER,
          via: "studio",
          message: "",
          publishedAt: new Date().toISOString(),
          ...meta,
        },
      });
      state.latest = id;
      return id;
    },
    async save(name, set, deleted = [], userId = "usr_other") {
      const { draft } = ensure(name, "studio");
      const ifMatch: Record<string, string | null> = {};
      for (const n of [...Object.keys(set), ...deleted]) ifMatch[n] = await versionIn(draft, n);
      await applyTo(draft, { set, delete: deleted, ifMatch }, userId);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const takeInjected = (key: string): Injected | undefined => {
    const list = state.inject.get(key);
    if (!list || list.length === 0) return undefined;
    const head = list[0]!;
    if ((head.after ?? 0) > 0) {
      head.after = head.after! - 1;
      return undefined;
    }
    head.times = (head.times ?? 1) - 1;
    if (head.times <= 0) list.shift();
    return head;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const body = await readBody(req);
      state.requests.push({
        method: req.method ?? "GET",
        path: url.pathname + url.search,
        headers: req.headers,
        body,
      });
      const send = (status: number, json: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(json === undefined ? "" : JSON.stringify(json));
      };
      const answerInjected = (key: string): boolean => {
        const injected = takeInjected(key);
        if (!injected) return false;
        if (injected.destroy) req.socket.destroy();
        else send(injected.status, injected.json);
        return true;
      };

      // The CDN.
      const cdn = `/cdn/sites/${SITE}/`;
      if (url.pathname.startsWith(cdn)) {
        if (answerInjected("CDN")) return;
        const key = url.pathname.slice(cdn.length);
        if (key === "latest.json") {
          if (state.latest === null) return send(404, { error: "not found" });
          const index = await indexOf(state.latest);
          return send(200, { ...index, previewHosts: ["www.store.test"] });
        }
        const revision = /^revisions\/([^/]+)\/index\.json$/.exec(key);
        if (revision) {
          return state.revisions.has(revision[1]!)
            ? send(200, await indexOf(revision[1]!))
            : send(404, { error: "not found" });
        }
        const hash = /^blocks\/([A-Za-z0-9_-]{22})\.json$/.exec(key)?.[1];
        if (hash !== undefined) {
          for (const r of state.revisions.values()) {
            for (const block of Object.values(r.blocks)) {
              if ((await blockVersion(block)) === hash) return send(200, block);
            }
          }
          return send(404, { error: "not found" });
        }
        // A draft folder: its index, then one file per name (contract §2.6, §2.7).
        const draft = /^drafts\/([^/]+)\/([^/]+)$/.exec(key);
        if (draft) {
          const found = [...state.drafts.values()].find((d) => d.slug === draft[1]);
          if (!found?.etag) return send(404, { error: "not found" });
          const { set, delete: deleted, editors } = found.body;
          if (draft[2] === "index.json") {
            const names = [...new Set([...Object.keys(set), ...deleted])].sort();
            return send(200, { names });
          }
          const file = decodeURIComponent(draft[2]!);
          const name = file === "%69ndex.json" ? "index" : decodeURIComponent(file.slice(0, -5));
          const editor = editors[name];
          const who = editor ? { user: editor.userId, via: "cli", at: editor.at } : {};
          if (Object.hasOwn(set, name))
            return send(200, { operation: "set", data: set[name], ...who });
          if (deleted.includes(name)) return send(200, { operation: "delete", ...who });
          return send(404, { error: "not found" });
        }
        return send(404, { error: "not found" });
      }

      // The Studio API.
      // Studio's gate order (contract §4.1): 401, then the site (its org is Studio's).
      const route = /^\/api\/cms\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!route) return send(404, { error: "no route", code: "not_found" });
      if (req.headers.authorization !== `Bearer ${TOKEN}`)
        return send(401, { error: "Unauthorized" });
      if (decodeURIComponent(route[1]!) !== SITE)
        return send(404, { error: "Site not found", code: "site_not_found" });
      const rest = route[2] ?? "";
      const key = `${req.method} ${rest}`;
      if (answerInjected(key)) return;
      const segments = rest.split("/").filter(Boolean).map(decodeURIComponent);

      if (segments[0] === "drafts" && segments.length === 1) {
        if (req.method === "GET") {
          const drafts = [...state.drafts.values()]
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
            .map(({ name, slug, createdBy, via, createdAt }) => ({
              name,
              slug,
              createdBy,
              via,
              createdAt,
            }));
          return send(200, { drafts });
        }
        if (req.method === "POST") {
          const { name } = JSON.parse(body);
          const { draft, created } = ensure(name);
          return send(200, { ...draftAnswer(draft), created });
        }
      }
      if (segments[0] === "drafts" && segments.length >= 2) {
        const draft = state.drafts.get(segments[1]!);
        if (!draft) return send(404, { error: "no such draft", code: "draft_not_found" });
        if (segments.length === 2 && req.method === "GET") return send(200, draftAnswer(draft));
        if (segments.length === 2 && req.method === "DELETE") {
          state.drafts.delete(draft.name);
          return send(200, { discarded: true });
        }
        if (segments[2] === "rpc" && req.method === "POST") {
          const rpc = JSON.parse(body);
          if (rpc.method !== "blocks.apply") {
            return send(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32601, message: "unknown" },
            });
          }
          const race = fake.beforeApply;
          fake.beforeApply = null;
          await race?.();
          const answer = await applyTo(draft, rpc.params, USER);
          return send(200, { jsonrpc: "2.0", id: rpc.id, ...answer });
        }
        if (segments[2] === "publish" && req.method === "POST") {
          const { message } = body ? JSON.parse(body) : {};
          const base = state.latest ? state.revisions.get(state.latest)!.blocks : map();
          let same = true;
          for (const [name, block] of Object.entries(draft.body.set)) {
            if (
              !Object.hasOwn(base, name) ||
              (await blockVersion(base[name])) !== (await blockVersion(block))
            )
              same = false;
          }
          for (const name of draft.body.delete) if (Object.hasOwn(base, name)) same = false;
          const empty = () => {
            const wasEmpty =
              Object.keys(draft.body.set).length === 0 && draft.body.delete.length === 0;
            draft.body = { set: map(), delete: [], editors: {} };
            if (!wasEmpty) draft.etag = nextEtag();
            return true;
          };
          if (same)
            return send(200, {
              result: "up-to-date",
              revision: state.latest,
              draftEmptied: empty(),
            });
          const blocks = map(base);
          for (const name of draft.body.delete) delete blocks[name];
          for (const [name, block] of Object.entries(draft.body.set)) blocks[name] = block;
          const previous = state.latest;
          const revision = fake.release(blocks, {
            draft: draft.name,
            via: "cli",
            message: message ?? "",
          });
          return send(200, { result: "published", revision, previous, draftEmptied: empty() });
        }
      }
      if (segments[0] === "releases" && req.method === "GET") {
        const ids = [...state.revisions.keys()].sort();
        const start = Number(url.searchParams.get("cursor") ?? "0");
        const page = ids.slice(start, start + 2);
        return send(200, {
          live: state.latest,
          revisions: page.map((id) => ({
            id,
            status: id === state.latest ? "current" : "listed",
            meta: state.revisions.get(id)!.meta,
          })),
          nextCursor: start + 2 < ids.length ? String(start + 2) : null,
        });
      }
      if (segments[0] === "schema" && req.method === "PUT") {
        state.schema = body;
        return send(200, {
          etag: "schemaetag",
          blocksMajor: JSON.parse(body).blocksMajor === 8 ? 8 : null,
        });
      }
      return send(404, { error: "no route", code: "not_found" });
    })().catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  fake.studioUrl = `http://127.0.0.1:${port}`;
  fake.deliveryUrl = `http://127.0.0.1:${port}/cdn`;
  fake.env = {
    DECO_STUDIO_URL: fake.studioUrl,
    DECO_DELIVERY_URL: fake.deliveryUrl,
    DECO_TOKEN: TOKEN,
  };
  return fake;
}
