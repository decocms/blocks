/**
 * A client: one revision, loaded on first use and read for the rest of its
 * life, plus a memo of block results. Create one per request.
 */
import { errors, isResolutionError, ResolutionError } from "./errors.ts";
import { isBlock } from "./json.ts";
import { Resolver } from "./resolver.ts";
import type { ClientTelemetry } from "./telemetry.ts";
import type {
  Block,
  Blocks,
  Client,
  CMSError,
  ListOptions,
  ResolveOptions,
  Result,
  Snapshot,
} from "./types.ts";

interface ClientOptions {
  /** Loads this client's snapshot; called at most once. */
  load: () => Promise<Snapshot>;
  blocks: Blocks;
  /** The built-ins, with this CMS's `secret`. */
  builtIns: Readonly<Blocks>;
  onCollision?: (name: string) => void;
  telemetry?: ClientTelemetry;
}

type Loaded = { resolver: Resolver; snapshot: Snapshot } | { error: CMSError };

export class CMSClient implements Client {
  readonly #options: ClientOptions;
  readonly #reported = new WeakSet<CMSError>();
  #loaded: Promise<Loaded> | undefined;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  async resolve<T = unknown>(target: unknown, options: ResolveOptions = {}): Promise<Result<T>> {
    const loaded = await this.#load();
    if ("error" in loaded) return this.#fail(loaded.error);
    const { resolver } = loaded;
    const run = options.run !== false;
    try {
      if (typeof target === "string") {
        if (resolver.entry(target) === undefined) return this.#fail(errors.notFound(target));
        const value = run ? await resolver.resolveEntry(target) : resolver.expandEntry(target);
        return [value as T, null];
      }
      const value = run
        ? await resolver.resolve(target, [], [], false)
        : resolver.expand(target, [], [], false);
      return [value as T, null];
    } catch (error) {
      return this.#fail(asCMSError(error));
    }
  }

  async list<T = Block>(type: string, options: ListOptions<T> = {}): Promise<Result<T[]>> {
    const loaded = await this.#load();
    if ("error" in loaded) return this.#fail(loaded.error);
    const { resolver, snapshot } = loaded;
    const wanted = resolver.canonicalType(type);
    const names = Object.keys(snapshot.blocks)
      .sort(byCodeUnit)
      .filter((name) => {
        const entry = snapshot.blocks[name];
        return isBlock(entry) && resolver.canonicalType(entry.__resolveType) === wanted;
      });

    let entries: T[];
    try {
      const values = await Promise.all(
        names.map((name) =>
          options.run === true
            ? resolver.resolveEntry(name).catch((error) => {
                throw atEntry(name, error);
              })
            : resolver.expandEntry(name),
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
    const loaded = await this.#load();
    if ("error" in loaded) throw loaded.error;
    return loaded.snapshot.revision;
  }

  #load(): Promise<Loaded> {
    this.#loaded ??= this.#options.load().then(
      (snapshot): Loaded => ({
        snapshot,
        resolver: new Resolver({
          snapshot,
          blocks: this.#options.blocks,
          builtIns: this.#options.builtIns,
          onCollision: this.#options.onCollision,
          onBlock: this.#options.telemetry?.block,
        }),
      }),
      (error): Loaded => ({
        error: isResolutionError(error)
          ? error
          : errors.loaderFailed("the content loader failed", error),
      }),
    );
    return this.#loaded;
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

/** Plain code-unit order, the same on every server and locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asCMSError(error: unknown): CMSError {
  return isResolutionError(error) ? error : errors.blockFailed("<unknown>", [], error);
}

/** Prefixes a failed list entry's path with the entry's name, so the log says which one. */
function atEntry(name: string, error: unknown): unknown {
  if (!isResolutionError(error) || error.code === "CYCLE") return error;
  return new ResolutionError(error.code, error.message, [name, ...error.path], error.cause);
}
