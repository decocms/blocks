/**
 * The two services the remote commands talk to: the Studio content API (the
 * only writer, site-keyed at `/api/cms/<site>`) and the public CDN
 * (`latest.json`, revisions and drafts, read with no credential). Every
 * answer is mapped to an exit code here (spec: cli › Exit codes); the CLI
 * never retries.
 */
import { ErrorCode } from "../../../protocol/errors.ts";
import { spellingKey } from "../../../protocol/keys.ts";
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

  /** The live revision id, or `null` before the site's first publish. */
  async latest(): Promise<string | null> {
    const body = await this.#getJson(this.#url("latest.json"), "latest.json");
    if (body === null) return null;
    if (!isObject(body) || !isRevisionId(body.revision)) {
      throw new CliError("the CDN's latest.json names no valid revision", { code: "bad_answer" });
    }
    return body.revision;
  }

  /** A revision's blocks; `null` when there's no such revision. */
  async revision(id: string): Promise<Record<string, unknown> | null> {
    const body = await this.#getJson(this.#url(`revisions/${id}/data.json`), `revision ${id}`);
    if (body === null) return null;
    if (!isObject(body) || !isObject(body.blocks)) {
      throw new CliError(`the CDN's revision ${id} has no blocks`, { code: "bad_answer" });
    }
    return toMap(body.blocks);
  }

  /** Production now: the live revision and its blocks (empty before a first publish). */
  async production(): Promise<{ revision: string | null; blocks: Record<string, unknown> }> {
    const revision = await this.latest();
    if (revision === null) return { revision, blocks: Object.create(null) };
    const blocks = await this.revision(revision);
    if (blocks === null) {
      throw new CliError(`latest.json names revision ${revision}, which the CDN doesn't have`, {
        code: "revision_not_found",
      });
    }
    return { revision, blocks };
  }

  /** A draft object, by slug and ETag (the empty draft when it doesn't exist). */
  async draft(slug: string, etag: string | null): Promise<DraftBody> {
    if (etag === null) return { set: Object.create(null), delete: [], editors: {} };
    const query = `?v=${encodeURIComponent(etag)}`;
    const body = await this.#getJson(this.#url(`drafts/${slug}.json${query}`), "the draft");
    if (body === null) return { set: Object.create(null), delete: [], editors: {} };
    if (
      !isObject(body) ||
      !isObject(body.set) ||
      !Array.isArray(body.delete) ||
      body.delete.some((n) => typeof n !== "string")
    ) {
      throw new CliError("the CDN's draft isn't {set, delete}", { code: "bad_answer" });
    }
    return {
      set: toMap(body.set),
      delete: body.delete as string[],
      editors: isObject(body.editors) ? (body.editors as DraftBody["editors"]) : {},
    };
  }
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
