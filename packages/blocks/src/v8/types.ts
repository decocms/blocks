/**
 * Public types of the next-major (v8) core SDK. See the API reference
 * (`/next/api-reference#types`) — every type here is documented there.
 */
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Blocks and content
// ---------------------------------------------------------------------------

/**
 * A block as stored: the JSON in `.deco/blocks`, and what `client.list` and
 * `{ run: false }` return. Props never use it: a field's type is the value the
 * function receives.
 */
export type Block = { __resolveType: string; [input: string]: unknown };

/** A function a block can call. */
export type BlockFunction = (inputs: any) => unknown | Promise<unknown>;

/** A block map: what `.deco/index.ts` exports and the CLI reads. */
export type Blocks = Record<string, BlockFunction>;

/** One fixed copy of the content: what the content module exports and `load()` returns. */
export type Snapshot = {
  revision: string;
  /** The content map: entry name → saved JSON. */
  blocks: Record<string, unknown>;
  /** The alias table `deco content` writes: old type name → your type. */
  aliases?: Record<string, string>;
};

/**
 * The content module `deco content` writes: a snapshot plus `root`, the
 * `.deco` folder it was generated from, which `createCMS` keys its instance
 * on (see /next/api-reference#one-instance-per-process). Not exported.
 */
export type ContentModule = Snapshot & { root?: string };

/**
 * A source of content: `load()` returns it. Drafts aren't a loader's job:
 * `forDraft` layers a draft's changes over what `load()` returned.
 */
export interface Loader {
  load(): Promise<Snapshot>;
  update?(): Promise<{ updated: boolean }>;
}

/** The parts of a draft pointer, `<host[:port]><path[?query]>@<version>`. */
export interface DraftPointer {
  /** `host[:port]` of the Studio API that serves the draft's changes. */
  host: string;
  /** Starts with `/`; opaque to the app. Never carries the `__variant` parameters. */
  path: string;
  /** Opaque: the commit of the editor's last save. `"local"` names no draft (`deco serve`). */
  version: string;
  /** The variants this preview forces (the query's `__variant` parameters); absent when none. */
  variants?: ForcedVariant[];
}

/**
 * A variant a preview forces: the multivariate block at `path` (dot-separated
 * keys and indexes, `""` for the saved block itself) inside the saved block
 * `block` shows its variant `index` instead of evaluating rules.
 */
export interface ForcedVariant {
  block: string;
  path: string;
  index: number;
}

// ---------------------------------------------------------------------------
// Built-in types
// ---------------------------------------------------------------------------

/** An entry that lives at a URL. Extend it to make a type routable. */
export interface Route {
  /** @title Name */
  name: string;
  /** @title Path */
  path: string;
}

export interface Seo {
  title: string;
  description: string;
}

/** The built-in `page` block, resolved: without `seo`, the site's defaults apply. */
export interface Page extends Route {
  seo?: Seo;
  sections: ReactNode[];
}

/** The built-in `redirect` block. */
export interface Redirect {
  /** Literal path or template (`:name` segments, an optional trailing `/*`). */
  from: string;
  to: string;
  /** `true` for a 301, `false` for a 302. */
  permanent: boolean;
  /** Wins over `permanent`. */
  status?: RedirectStatus;
  /** Drop the request's query string instead of carrying it over. */
  discardQueryParameters?: boolean;
}

export type RedirectStatus = 301 | 302 | 307 | 308;

/**
 * The nested redirect shape v7 content stores (`website/loaders/redirect.ts`).
 * `matchRoute` accepts it next to {@link Redirect}: `permanent` is a 301 and
 * anything else a 307, the status the site editor has always written for it.
 */
export interface LegacyRedirect {
  redirect: {
    from: string;
    to: string;
    type?: "permanent" | "temporary";
    discardQueryParameters?: boolean;
  };
}

/** A field the site editor saves encrypted, as a `secret` block. */
export type Secret = string & { readonly __secret: true };

/** A prop the built-in `lazy` block fills; resolves its value when called, at most once. */
export type Lazy<T> = () => Promise<T>;

/** One entry of `variants`: a rule and the variant it shows. */
export interface Variant<T> {
  rule: boolean;
  value: Lazy<T>;
}

/**
 * The built-in `cms-settings` block's props: the type of the well-known saved
 * block `CMS`. Every field is optional, and any field can have variants. Read
 * it through `cms.settings()`, which fills in the defaults and applies code's
 * caps (see /next/built-in-blocks#cms-settings).
 */
export interface CMSSettings {
  /** Host patterns previews are allowed on, within `createCMS`'s `preview.hosts`. */
  preview?: { hosts?: string[] };
  telemetry?: Telemetry;
  analytics?: Analytics;
}

/** What `cms.settings()` returns: every section, defaults filled in, caps applied. */
export interface EffectiveSettings {
  /** `["*"]` means every host; an empty list, none. */
  preview: { hosts: string[] };
  telemetry: Required<Telemetry>;
  analytics: Required<Analytics>;
}

/** The `telemetry` section of the CMS settings. */
export interface Telemetry {
  /** Default `true`; `false` switches telemetry off. */
  enabled?: boolean;
  /** Default `true`. */
  metrics?: boolean;
  /** Default 0.05, capped by `telemetry.limits`. */
  errorSampleRate?: number;
  /** Default 0, capped by `telemetry.limits`. */
  traceSampleRate?: number;
}

/** The `analytics` section of the CMS settings, and `AnalyticsScript`'s props. */
export interface Analytics {
  /** An endpoint that accepts the One Dollar Stats format; default: the hosted Deco CMS collector. */
  collector?: string;
  /** Default `true`; `false` makes `AnalyticsScript` render nothing. */
  enabled?: boolean;
}

/** Anything with a `url` and `headers`: a fetch `Request`, a `NextRequest`, a framework wrapper. */
export type RequestLike = Request | { url: string; headers: { get(name: string): string | null } };

// ---------------------------------------------------------------------------
// Results and errors
// ---------------------------------------------------------------------------

export type CMSErrorCode =
  | "NOT_FOUND"
  | "UNKNOWN_BLOCK"
  | "CYCLE"
  | "BLOCK_FAILED"
  | "LOADER_FAILED";

export interface CMSError {
  code: CMSErrorCode;
  message: string;
  /** Where in the tree it happened, such as `["sections", 2, "product"]`. */
  path: (string | number)[];
  /** The original error, for `BLOCK_FAILED` and `LOADER_FAILED`. */
  cause?: unknown;
}

export type Result<T> = [T, null] | [null, CMSError];

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type Match<T> =
  | { kind: "match"; entry: T; params: Record<string, string> }
  | { kind: "redirect"; location: string; status: RedirectStatus }
  | { kind: "not-found" };

// ---------------------------------------------------------------------------
// The CMS and its clients
// ---------------------------------------------------------------------------

export type TelemetryConfig = (
  | { site: string; token: string }
  | { endpoint: string; headers?: Record<string, string> }
) & {
  limits?: { errorSampleRate?: number; traceSampleRate?: number };
};

export interface CMSConfig {
  /** Your block functions; the CMS uses `{ ...builtIns, ...blocks }`. */
  blocks: Blocks;
  /** The content module (`.deco/blocks.gen.ts`), or any {@link Loader}. */
  content: ContentModule | Loader;
  /** ms between `update()` checks of a content source that has one; minimum 60 000. */
  interval?: number;
  /** Where telemetry goes; see /next/telemetry. */
  telemetry?: false | TelemetryConfig;
  preview?: {
    /**
     * The most content may allow previews on, in the host pattern format
     * (/next/api-reference#host-patterns). Without it, content may allow any host.
     */
    hosts?: string[];
    /**
     * The hosts a draft pointer may name, in the host pattern format; code
     * only, never content. Default `["studio.decocms.com"]`.
     */
    sources?: string[];
  };
  /** The private key that decrypts `secret` blocks. */
  secrets?: { key?: string };
  /** Your site's ID, for hosted releases. Drafts don't need it. */
  site?: string;
  /** Your site token (secret), for hosted releases. Drafts don't need it. */
  token?: string;
}

export interface ResolveOptions {
  /** `false` reads without running: saved blocks expand, no function runs. */
  run?: boolean;
}

export interface ListOptions<T> {
  where?: (entry: T) => boolean;
  sort?: (a: T, b: T) => number;
  limit?: number;
  run?: boolean;
}

/**
 * Reads one revision for one request.
 *
 * Results are read-only. A client runs each block function once per distinct
 * input, so the same block at two places in a request hands both places the
 * same object; mutating it in place changes the other occurrence too. Copy a
 * result before changing it. (The memo belongs to one client, so nothing is
 * shared across requests.)
 */
export interface Client {
  resolve<T = unknown>(target: unknown, options?: ResolveOptions): Promise<Result<T>>;
  list<T = Block>(type: string, options?: ListOptions<T>): Promise<Result<T[]>>;
  /**
   * The revision this client reads (loads it on first use). Unlike `resolve`
   * and `list`, it rejects with the `LOADER_FAILED` error when the content
   * can't load, since there is no revision to report.
   */
  revision(): Promise<string>;
}

export interface CMS {
  /** A client reading the current release. */
  forRelease(): Client;
  /**
   * A client reading the draft a pointer names: its changes, fetched from a
   * host in `preview.sources`, over this server's production content.
   */
  forDraft(pointer: string): Client;
  /** A client pinned to a revision this CMS has served; an unknown revision behaves like the release. */
  forRevision(revision: string): Client;
  /** Ask the content source for newer content now; never throws. */
  update(): Promise<{ updated: boolean }>;
  /**
   * The release's CMS settings (the saved block `CMS`), defaults filled in and
   * code's caps applied. Reads the release already in memory, never a draft;
   * never fetches, never rejects.
   */
  settings(): Promise<EffectiveSettings>;
  /**
   * The request's draft pointer: `?__draft=` first, then the `deco-draft`
   * cookie. `null` when neither is present, for `?__draft=off`, and on a host
   * outside `settings().preview.hosts`, where the request gets the release.
   */
  draftPointer(request: RequestLike): Promise<string | null>;
  /**
   * The `Set-Cookie` value that starts a preview (a valid `?__draft=` on an
   * allowed host) or ends one (`?__draft=off`, on any host); `null` otherwise.
   */
  draftCookie(request: RequestLike): Promise<string | null>;
}
