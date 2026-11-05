/**
 * The two services the remote commands talk to: the Studio content API (the
 * only writer, site-keyed at `/api/cms/<site>`) and the public CDN
 * (`latest.json`, the revision index; `blocks/<hash>.json`; `revisions/<id>/index.json`;
 * draft folders; read with no credential). Every
 * answer is mapped to an exit code here (spec: cli › Exit codes); the CLI
 * never retries.
 */
import { ErrorCode } from "../../../protocol/errors.ts";
import { spellingKey } from "../../../protocol/keys.ts";
import { draftFileName } from "../../draftChanges.ts";
import { isRevisionId } from "../../revisionId.ts";
import { CliError, EXIT, packageVersion } from "../root.ts";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Per CDN fetch, as the SDK's (headers and body). */
const CDN_TIMEOUT_MS = 10_000;
/** Per Studio request: a publish of a large site takes seconds, never minutes. */
const STUDIO_TIMEOUT_MS = 120_000;

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function networkError(what: string, error: unknown): CliError {
  const why = isTimeout(error)
    ? "timed out"
    : `unreachable (${(error as Error)?.message ?? error})`;
  return new CliError(`${what} ${why}`, { exitCode: EXIT.network, code: "network" });
}

// ---------------------------------------------------------------------------
// Studio
// ---------------------------------------------------------------------------

export interface Draft {
  name: string;
  slug: string;
  createdBy: string;
  via: string;
  createdAt: string;
  etag: string | null;
  pointer: string | null;
  previewUrl: string | null;
}

export interface DraftRow {
  name: string;
  slug: string;
  createdBy: string;
  via: string;
  createdAt: string;
}

/** A Releases row (contract §4.10); an `unreadable` one has no `meta`. */
export interface ReleaseRow {
  id: string;
  /** `current`: the one latest.json names; `listed`: any other. */
  status: "current" | "listed" | "unreadable";
  meta?: Record<string, unknown>;
}

export interface ReleasesPage {
  live: string | null;
  revisions: ReleaseRow[];
  nextCursor: string | null;
}

export type PublishResult =
  | { result: "published"; revision: string; previous: string | null; draftEmptied: boolean }
  | { result: "up-to-date"; revision: string | null; draftEmptied: boolean };

/** A JSON-RPC error answer of `blocks.apply`. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
  }
}

export interface StudioOptions {
  base: string;
  site: string;
  token: () => Promise<string>;
  fetch?: Fetch;
}

export interface ApplyParams {
  set: Record<string, unknown>;
  delete: string[];
  ifMatch: Record<string, string | null>;
}

export interface ApplyResult {
  revision: string;
  versions: Record<string, string | null>;
}

/** The exit code for a non-2xx Studio answer (spec: cli › Exit codes). */
export function exitCodeForStatus(status: number, code: string | undefined): number {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 429) return EXIT.busy;
  if (status === 409 && code === "production_moved") return EXIT.busy;
  if (status === 503 && code === "unavailable") return EXIT.busy;
  if (status >= 500) return EXIT.network;
  return EXIT.failed;
}

/** The exit code for a JSON-RPC error of the content protocol. */
export function exitCodeForRpc(code: number): number {
  if (code === ErrorCode.Conflict) return EXIT.conflict;
  if (code === ErrorCode.Unavailable) return EXIT.busy;
  if (code === ErrorCode.Unauthorized || code === ErrorCode.Forbidden) return EXIT.auth;
  return EXIT.failed;
}

export class Studio {
  readonly #options: StudioOptions;
  readonly #fetch: Fetch;

  constructor(options: StudioOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  /** The site's API root, `<studio>/api/cms/<site>` (Studio finds the site's org). */
  get root(): string {
    const { base, site } = this.#options;
    return `${base}/api/cms/${encodeURIComponent(site)}`;
  }

  async #request(
    method: string,
    path: string,
    body?: { json: unknown } | { bytes: Uint8Array | string },
  ): Promise<{ status: number; json: any }> {
    const token = await this.#options.token();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "user-agent": `deco-cli/${packageVersion()}`,
    };
    let payload: BodyInit | undefined;
    if (body) {
      headers["content-type"] = "application/json";
      payload = "json" in body ? JSON.stringify(body.json) : (body.bytes as BodyInit);
    }
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${this.root}${path}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(STUDIO_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (error) {
      throw networkError(`Studio (${this.#options.base})`, error);
    }
    let json: any;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (response.status < 200 || response.status > 299) {
      const code = typeof json?.code === "string" ? json.code : undefined;
      const exitCode = exitCodeForStatus(response.status, code);
      const message =
        typeof json?.error === "string"
          ? json.error
          : typeof json?.error?.message === "string"
            ? json.error.message
            : `HTTP ${response.status}`;
      const hint =
        exitCode === EXIT.auth && response.status === 401
          ? " (check DECO_TOKEN, or log in again with npx decocms auth login)"
          : "";
      throw new CliError(`Studio answered ${response.status}: ${message}${hint}`, {
        exitCode,
        code: code ?? (exitCode === EXIT.auth ? "unauthorized" : `http_${response.status}`),
        details: { status: response.status },
      });
    }
    return { status: response.status, json };
  }

  static draftPath(name: string): string {
    return `/drafts/${encodeURIComponent(name)}`;
  }

  async listDrafts(): Promise<DraftRow[]> {
    return (await this.#request("GET", "/drafts")).json.drafts ?? [];
  }

  async ensureDraft(name: string): Promise<Draft & { created: boolean }> {
    return (await this.#request("POST", "/drafts", { json: { name } })).json;
  }

  async resolveDraft(name: string): Promise<Draft> {
    return (await this.#request("GET", Studio.draftPath(name))).json;
  }

  async discardDraft(name: string): Promise<void> {
    await this.#request("DELETE", Studio.draftPath(name));
  }

  /**
   * One `blocks.apply` on the draft. `body` is the serialized JSON-RPC
   * request (push measures it against the 8 MiB cap). A JSON-RPC error is
   * thrown as `RpcError`.
   */
  async apply(name: string, body: string): Promise<ApplyResult> {
    const { json } = await this.#request("POST", `${Studio.draftPath(name)}/rpc`, { bytes: body });
    if (json?.error) {
      throw new RpcError(
        Number(json.error.code),
        String(json.error.message ?? ""),
        json.error.data,
      );
    }
    if (!json || typeof json.result !== "object" || json.result === null) {
      throw new CliError("Studio answered blocks.apply with no result", { code: "bad_answer" });
    }
    return json.result;
  }

  async publish(name: string, message: string | undefined): Promise<PublishResult> {
    const body = message === undefined ? {} : { message };
    return (await this.#request("POST", `${Studio.draftPath(name)}/publish`, { json: body })).json;
  }

  async releases(cursor: string | undefined): Promise<ReleasesPage> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return (await this.#request("GET", `/releases${query}`)).json;
  }

  async pushSchema(text: string): Promise<{ etag: string; blocksMajor: number | null }> {
    return (await this.#request("PUT", "/schema", { bytes: text })).json;
  }
}

/** One `blocks.apply` request, serialized as `deco push` sends it. */
export function applyRequestBody(params: ApplyParams): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "blocks.apply", params });
}

// ---------------------------------------------------------------------------
// The CDN
// ---------------------------------------------------------------------------

/** A revision index as the CDN serves it: name → the body's hash (and the inline `CMS` body). */
export interface RemoteIndex {
  revision: string;
  sequence: number;
  blocks: Record<string, { version: string; data?: Record<string, unknown> }>;
}

/** A block's hash: `blockVersion`, 22 base64url characters. */
const HASH = /^[A-Za-z0-9_-]{22}$/;
/** CDN reads in flight at once, for a pull of every block (contract A-31). */
const PARALLELISM = 16;

export interface DraftBody {
  set: Record<string, unknown>;
  delete: string[];
  editors: Record<string, { userId: string; at: number }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the public bucket: no credentials, never a cached answer. */
export class Delivery {
  readonly #base: string;
  readonly #site: string;
  readonly #fetch: Fetch;

  constructor(base: string, site: string, fetchImpl: Fetch = fetch) {
    this.#base = base;
    this.#site = site;
    this.#fetch = fetchImpl;
  }

  #url(key: string): string {
    return `${this.#base}/sites/${encodeURIComponent(this.#site)}/${key}`;
  }

  /** `null` on 404. */
  async #getJson(url: string, what: string): Promise<unknown | null> {
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(url, {
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(CDN_TIMEOUT_MS),
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      text = await response.text();
    } catch (error) {
      throw networkError(`the CDN (${what})`, error);
    }
    if (response.status !== 200) {
      throw new CliError(`the CDN answered ${response.status} for ${what}`, {
        exitCode: response.status >= 500 ? EXIT.network : EXIT.failed,
        code: response.status >= 500 ? "network" : `http_${response.status}`,
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new CliError(`the CDN's ${what} isn't JSON`, { code: "bad_answer" });
    }
  }

  /** A revision index (`latest.json` or `revisions/<id>/index.json`); `null` on 404. */
  async #index(key: string, what: string): Promise<RemoteIndex | null> {
    const body = await this.#getJson(this.#url(key), what);
    if (body === null) return null;
    const bad = (why: string) => new CliError(`the CDN's ${what} ${why}`, { code: "bad_answer" });
    if (!isObject(body) || !isRevisionId(body.revision)) throw bad("names no valid revision");
    const sequence = body.sequence;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw bad("has no valid sequence");
    }
    if (!isObject(body.blocks)) throw bad("has no blocks");
    const blocks: RemoteIndex["blocks"] = Object.create(null);
    for (const [name, entry] of Object.entries(body.blocks)) {
      if (!isObject(entry) || typeof entry.version !== "string" || !HASH.test(entry.version)) {
        throw bad(`has no valid version for "${name}"`);
      }
      blocks[name] = isObject(entry.data)
        ? { version: entry.version, data: entry.data }
        : { version: entry.version };
    }
    return { revision: body.revision, sequence, blocks };
  }

  /** The live index (`latest.json`), or `null` before the site's first publish. */
  latestIndex(): Promise<RemoteIndex | null> {
    return this.#index("latest.json", "latest.json");
  }

  /** The live revision id, or `null` before the site's first publish. */
  async latest(): Promise<string | null> {
    return (await this.latestIndex())?.revision ?? null;
  }

  /**
   * The bodies of `names` (every name by default) in an index: inline ones
   * from the index, the others by hash, at most 16 fetches at a time.
   */
  async bodies(index: RemoteIndex, names?: readonly string[]): Promise<Record<string, unknown>> {
    const wanted = (names ?? Object.keys(index.blocks)).filter((name) =>
      Object.hasOwn(index.blocks, name),
    );
    const blocks: Record<string, unknown> = Object.create(null);
    await inParallel(wanted, PARALLELISM, async (name) => {
      const entry = index.blocks[name]!;
      if (entry.data !== undefined) {
        blocks[name] = entry.data;
        return;
      }
      const what = `block "${name}" (${entry.version})`;
      const body = await this.#getJson(this.#url(`blocks/${entry.version}.json`), what);
      if (body === null) {
        throw new CliError(`the CDN doesn't have ${what}, which revision ${index.revision} names`, {
          code: "block_not_found",
        });
      }
      blocks[name] = body;
    });
    // In the index's order, not the order the fetches finished in.
    const ordered: Record<string, unknown> = Object.create(null);
    for (const name of wanted) ordered[name] = blocks[name];
    return ordered;
  }

  /** A revision's blocks; `null` when there's no such revision. */
  async revision(id: string): Promise<Record<string, unknown> | null> {
    const index = await this.#index(`revisions/${id}/index.json`, `revision ${id}`);
    return index === null ? null : this.bodies(index);
  }

  /** Production now: the live revision and its blocks (empty before a first publish). */
  async production(): Promise<{ revision: string | null; blocks: Record<string, unknown> }> {
    const index = await this.latestIndex();
    if (index === null) return { revision: null, blocks: Object.create(null) };
    return { revision: index.revision, blocks: await this.bodies(index) };
  }

  /**
   * A draft, by slug (the empty draft when Studio has none, `etag` null): its
   * folder's `index.json`, then every file it names. A missing file or a
   * `published` marker is no change; a `set` file's body replaces the name,
   * a `delete` file deletes it.
   */
  async draft(slug: string, etag: string | null): Promise<DraftBody> {
    const empty = (): DraftBody => ({ set: Object.create(null), delete: [], editors: {} });
    if (etag === null) return empty();
    const folder = `drafts/${slug}/`;
    const index = await this.#getJson(this.#url(`${folder}index.json`), "the draft's index");
    if (index === null) return empty();
    if (!isObject(index) || !Array.isArray(index.names)) {
      throw new CliError("the CDN's draft index isn't {names}", { code: "bad_answer" });
    }
    const names = [...new Set(index.names.filter((n): n is string => typeof n === "string"))];
    const files: Record<string, unknown> = Object.create(null);
    await inParallel(names, PARALLELISM, async (name) => {
      const url = this.#url(`${folder}${encodeURIComponent(draftFileName(name))}`);
      files[name] = await this.#getJson(url, `the draft's file for "${name}"`);
    });
    const draft = empty();
    for (const name of names) {
      const file = files[name];
      if (file === null || file === undefined) continue;
      const bad = () =>
        new CliError(`the CDN's draft file for "${name}" isn't a set, delete or published`, {
          code: "bad_answer",
        });
      if (!isObject(file)) throw bad();
      if (file.operation === "published") continue;
      if (file.operation === "set") {
        if (!isObject(file.data)) throw bad();
        draft.set[name] = file.data;
      } else if (file.operation === "delete") {
        draft.delete.push(name);
      } else throw bad();
      if (typeof file.user === "string" && typeof file.at === "number") {
        draft.editors[name] = { userId: file.user, at: file.at };
      }
    }
    return draft;
  }
}

/** Runs `task` over `items`, at most `limit` at a time; rejects with the first failure. */
async function inParallel<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** A copy with no prototype, so a block named `__proto__` is just a name. */
export function toMap(record: Record<string, unknown>): Record<string, unknown> {
  const map: Record<string, unknown> = Object.create(null);
  for (const [name, value] of Object.entries(record)) map[name] = value;
  return map;
}

/**
 * Production with a draft applied, as Studio applies it (`applyDraftToBlocks`):
 * a name the draft sets replaces every spelling of it, a name it deletes hides
 * every spelling (`spellingKey`), and its blocks are taken whole.
 */
export function layer(
  production: Record<string, unknown>,
  draft: { set: Record<string, unknown>; delete: string[] },
): Record<string, unknown> {
  const touched = new Set([...Object.keys(draft.set), ...draft.delete].map(spellingKey));
  const blocks: Record<string, unknown> = Object.create(null);
  for (const [name, block] of Object.entries(production)) {
    if (!touched.has(spellingKey(name))) blocks[name] = block;
  }
  for (const [name, block] of Object.entries(draft.set)) blocks[name] = block;
  return blocks;
}
