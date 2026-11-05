/**
 * A client: one request's reads. It pins one index on its first content
 * access (see ./pin.ts) and reads it, with every body it fetched, for the rest
 * of its life, plus a memo of block results, and the inputs it was created
 * with (the version, the visitor, the date, the tests and campaigns it was
 * given). Create one per request.
 *
 * The binding flow (see /next/routing): `routes()` → `matchRoute` →
 * `prefetch(name)` → `redirects()` → `matchRoute` → `resolve(name)`. The
 * page's subtree and the redirects block go out in one parallel wave.
 */
import {
  canonicalType,
  namesOfType,
  REDIRECTS_TYPE,
  redirectsBlockOf,
  routesOf,
  walk,
} from "./contentIndex.ts";
import { CAMPAIGN_OVERRIDES, EXPERIMENT_OVERRIDES, type Overrides } from "./current.ts";
import { errors, isResolutionError, ResolutionError } from "./errors.ts";
import type { Visitor } from "./experiments.ts";
import { isPlainObject } from "./json.ts";
import { choosePin, type Pin, rootsOf, type Selection } from "./pin.ts";
import { Resolver } from "./resolver.ts";
import type { ClientTelemetry } from "./telemetry.ts";
import type {
  Block,
  Blocks,
  Client,
  CMSError,
  LegacyRedirect,
  ListOptions,
  Redirect,
  ResolveOptions,
  Result,
  Route,
} from "./types.ts";

interface ClientOptions {
  /** Loads what this client reads; called at most once. */
  load: () => Promise<Selection>;
  blocks: Blocks;
  /** The built-in blocks. */
  builtIns: Readonly<Blocks>;
  /** Who is visiting (copied and frozen); `null` for none. */
  visitor?: Visitor | null;
  /** The version it was created with: `undefined` for the current release. */
  version?: string;
  /** The date campaigns run at, in ms since the epoch. */
  date: number;
  /** The tests it was given, on or off by name (frozen); `undefined` for none. */
  experiments?: Overrides;
  /** The campaigns it was given, on or off by name (frozen); `undefined` for none. */
  campaigns?: Overrides;
  onCollision?: (name: string) => void;
  telemetry?: ClientTelemetry;
}

type Selected = { selection: Selection } | { error: CMSError };
type Pinned = { pin: Pin; resolver: Resolver } | { error: CMSError };

/** Types `list()` warns about once per process: routing reads `routes()` and `redirects()`. */
const ROUTED_TYPES = new Set(["page", "redirect", REDIRECTS_TYPE]);
const LIST_WARNED = Symbol.for("decocms.blocks.listWarned");

export class CMSClient implements Client {
  readonly #options: ClientOptions;
  readonly #reported = new WeakSet<CMSError>();
  readonly #visitor: Visitor | null;
  #selected: Promise<Selected> | undefined;
  #pinned: Promise<Pinned> | undefined;
  /** The revision pinned, once it is. */
  #revision: string | undefined;

  constructor(options: ClientOptions) {
    this.#options = options;
    this.#visitor = copyVisitor(options.visitor);
  }

  get visitor(): Visitor | null {
    return this.#visitor;
  }

  get version(): string | undefined {
    return this.#options.version ?? this.#revision;
  }

  get date(): Date {
    return new Date(this.#options.date);
  }

  /** Read by the built-in `split-traffic` (see ./current.ts). */
  get [EXPERIMENT_OVERRIDES](): Overrides | undefined {
    return this.#options.experiments;
  }

  /** Read by the built-in `calendar` (see ./current.ts). */
  get [CAMPAIGN_OVERRIDES](): Overrides | undefined {
    return this.#options.campaigns;
  }

  async routes(): Promise<Result<Route[]>> {
    // A pinned client answers from its pin; otherwise the current index, without pinning.
    const pinned = this.#pinned === undefined ? undefined : await this.#pinned;
    if (pinned !== undefined) {
      if ("error" in pinned) return this.#fail(pinned.error);
      return [routesOf(pinned.pin.content), null];
    }
    const selected = await this.#select();
    if ("error" in selected) return this.#fail(selected.error);
    return [routesOf(selected.selection.current), null];
  }

  prefetch(name: string): void {
    if (typeof name !== "string") return;
    this.#pin(name).then(
      (pinned) => {
        if ("error" in pinned) return;
        return pinned.pin.wave(walk(pinned.pin.content, rootsOf(pinned.pin.content, name)));
      },
      () => {},
    );
  }

  async redirects(): Promise<Result<Redirect[]>> {
    const pinned = await this.#pin();
    if ("error" in pinned) return this.#fail(pinned.error);
    const { pin, resolver } = pinned;
    const name = redirectsBlockOf(pin.content);
    if (name === null) return [[], null];
    try {
      await pin.wave(walk(pin.content, [name]));
      const value = await resolver.resolveEntry(name);
      return [rulesOf(value), null];
    } catch (error) {
      return this.#fail(asCMSError(error));
    }
  }

  async resolve<T = unknown>(target: unknown, options: ResolveOptions = {}): Promise<Result<T>> {
    const pinned = await this.#pin(typeof target === "string" ? target : undefined);
    if ("error" in pinned) return this.#fail(pinned.error);
    const { pin, resolver } = pinned;
    const run = options.run !== false;
    try {
      if (typeof target === "string") {
        if (!resolver.has(target)) return this.#fail(errors.notFound(target));
        await pin.wave(walk(pin.content, [target]));
        const value = run
          ? await resolver.resolveEntry(target)
          : await resolver.expandEntry(target);
        return [value as T, null];
      }
      const value = run
        ? await resolver.resolve(target, [], [], false)
        : await resolver.expand(target, [], [], false);
      return [value as T, null];
    } catch (error) {
      return this.#fail(asCMSError(error));
    }
  }

  async list<T = Block>(type: string, options: ListOptions<T> = {}): Promise<Result<T[]>> {
    const pinned = await this.#pin();
    if ("error" in pinned) return this.#fail(pinned.error);
    const { pin, resolver } = pinned;
    warnRoutedList(canonicalType(pin.content, type));
    const names = namesOfType(pin.content, type);

    let entries: T[];
    try {
      await pin.wave(walk(pin.content, names));
      const values = await Promise.all(
        names.map((name) =>
          (options.run === true ? resolver.resolveEntry(name) : resolver.expandEntry(name)).catch(
            (error) => {
              throw atEntry(name, error);
            },
          ),
        ),
      );
      entries = values.filter((value) => value !== undefined) as T[];
    } catch (error) {
      return this.#fail(asCMSError(error));
    }

    if (options.where) entries = entries.filter(options.where);
    if (options.sort) entries = [...entries].sort(options.sort);
    if (typeof options.limit === "number" && options.limit >= 0) {
      entries = entries.slice(0, Math.floor(options.limit));
    }
    return [entries, null];
  }

  async revision(): Promise<string> {
    const pinned = await this.#pin();
    if ("error" in pinned) throw pinned.error;
    return pinned.pin.content.revision;
  }

  #select(): Promise<Selected> {
    this.#selected ??= this.#options.load().then(
      (selection): Selected => ({ selection }),
      (error): Selected => ({
        error: isResolutionError(error)
          ? error
          : errors.loaderFailed("the content loader failed", error),
      }),
    );
    return this.#selected;
  }

  /** Pins on the first content access; `name` is the page it will read, when known. */
  #pin(name?: string): Promise<Pinned> {
    this.#pinned ??= this.#select().then((selected): Pinned => {
      if ("error" in selected) return selected;
      const pin = choosePin(selected.selection, name);
      this.#revision = pin.content.revision;
      return {
        pin,
        resolver: new Resolver({
          content: pin,
          blocks: this.#options.blocks,
          builtIns: this.#options.builtIns,
          client: this,
          onCollision: this.#options.onCollision,
          onBlock: this.#options.telemetry?.block,
        }),
      };
    });
    return this.#pinned;
  }

  /** Returns the error result, reporting each error to telemetry once per client. */
  #fail(error: CMSError): [null, CMSError] {
    if (this.#options.telemetry && !this.#reported.has(error)) {
      this.#reported.add(error);
      this.#options.telemetry.error(error);
    }
    return [null, error];
  }
}

/** The redirects block's value: its rules, each an object (both shapes `matchRoute` reads). */
function rulesOf(value: unknown): Redirect[] {
  const list = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.redirects)
      ? value.redirects
      : [];
  return list.filter((rule): rule is Redirect | LegacyRedirect =>
    isPlainObject(rule),
  ) as Redirect[];
}

/**
 * `list("page")` and `list("redirect")` read every page or rule: routing reads
 * `routes()` and `redirects()` from the index instead. Warns once per process
 * and type, outside production.
 */
function warnRoutedList(type: string): void {
  if (!ROUTED_TYPES.has(type)) return;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (env?.NODE_ENV === "production") return;
  const store = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  const warned = store[LIST_WARNED] ?? new Set<string>();
  store[LIST_WARNED] = warned;
  if (warned.has(type)) return;
  warned.add(type);
  console.warn(
    `[decocms/blocks] client.list("${type}") fetches every ${type} block; route with ` +
      "client.routes() and client.redirects(), which read the index (see /next/routing).",
  );
}

/** Forgets which list types warned, so a test starts clean. */
export function resetListWarnings(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[LIST_WARNED];
}

/**
 * The client's own frozen copy of a visitor, so a caller changing its object
 * later changes no client; `null` for anything that isn't one.
 */
function copyVisitor(visitor: Visitor | null | undefined): Visitor | null {
  if (typeof visitor !== "object" || visitor === null || typeof visitor.id !== "string") {
    return null;
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  const copy: Visitor = {
    id: visitor.id,
    active: Object.freeze(strings(visitor.active)) as string[],
    inactiveDrawn: Object.freeze(strings(visitor.inactiveDrawn)) as string[],
    pct: Object.freeze(Object.assign(Object.create(null), visitor.pct)),
  };
  if (typeof visitor.exp === "object" && visitor.exp !== null) {
    copy.exp = Object.freeze(Object.assign(Object.create(null), visitor.exp));
  }
  return Object.freeze(copy);
}

function asCMSError(error: unknown): CMSError {
  return isResolutionError(error) ? error : errors.blockFailed("<unknown>", [], error);
}

/** Prefixes a failed list entry's path with the entry's name, so the log says which one. */
function atEntry(name: string, error: unknown): unknown {
  if (!isResolutionError(error) || error.code === "CYCLE") return error;
  return new ResolutionError(error.code, error.message, [name, ...error.path], error.cause);
}
