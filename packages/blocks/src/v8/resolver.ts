/**
 * The lookup rule and its evaluation (see /next/how-resolution-works).
 *
 * One registry, later keys win: `{ ...savedBlocks, ...builtIns, ...blocks }`.
 * A function runs with its inputs resolved first (inside out, siblings
 * concurrently); a saved block is replaced by `{ ...saved, ...arguments }` and
 * looked up again; anything else is `UNKNOWN_BLOCK`. The built-in `lazy` is
 * the one special case: its `value` is not resolved first.
 *
 * A `Resolver` belongs to one client, so its memo (results per block function
 * and canonical inputs) never outlives a request.
 */
import { builtIns, RESERVED_NAMES } from "./builtins/index";
import { isLazyBuiltin } from "./builtins/lazy";
import { errors, isResolutionError } from "./errors";
import { canonicalKey, isPlainObject, type JsonObject, own } from "./json";
import type { BlockFunction, Blocks, Lazy, Snapshot } from "./types";

type Path = (string | number)[];

interface ResolverOptions {
  snapshot: Snapshot;
  blocks: Blocks;
  /** Called once per name a saved block shares with a function. */
  onCollision?: (name: string) => void;
}

export class Resolver {
  readonly #snapshot: Snapshot;
  readonly #blocks: Blocks;
  readonly #onCollision?: (name: string) => void;
  readonly #memo = new WeakMap<BlockFunction, Map<string, Promise<unknown>>>();
  readonly #keys = new WeakMap<object, string | null>();

  constructor({ snapshot, blocks, onCollision }: ResolverOptions) {
    this.#snapshot = snapshot;
    this.#blocks = blocks;
    this.#onCollision = onCollision;
  }

  /** The saved entry with this name, or `undefined`. */
  entry(name: string): unknown {
    return own(this.#snapshot.blocks, name);
  }

  /** The type an alias points at, or the type itself. */
  canonicalType(type: string): string {
    return own(this.#snapshot.aliases, type) ?? type;
  }

  /** Resolves a saved entry by name (the target is known to exist). */
  resolveEntry(name: string): Promise<unknown> {
    return this.resolve(this.entry(name), [], [name], true);
  }

  /** Expands a saved entry by name without running anything. */
  expandEntry(name: string): unknown {
    return this.expand(this.entry(name), [], [name], true);
  }

  /**
   * Resolves any value. `chain` is the saved entries expanded on the current
   * path (for `CYCLE`); `fromContent` marks values that live in the snapshot,
   * which are always copied so no caller can mutate shared content.
   */
  async resolve(
    node: unknown,
    path: Path,
    chain: string[],
    fromContent: boolean,
  ): Promise<unknown> {
    if (Array.isArray(node)) {
      const results = await Promise.all(
        node.map((item, i) => this.resolve(item, [...path, i], chain, fromContent)),
      );
      const kept = results.filter((value) => value !== undefined);
      return !fromContent && sameItems(node, kept) ? node : kept;
    }
    if (!isPlainObject(node)) return node;
    if (typeof node.__resolveType === "string") {
      return this.#resolveBlock(node, node.__resolveType, path, chain, fromContent);
    }
    return this.#resolveFields(node, path, chain, fromContent);
  }

  /** Expands saved blocks in place without running any function (`{ run: false }`). */
  expand(node: unknown, path: Path, chain: string[], fromContent: boolean): unknown {
    if (Array.isArray(node)) {
      const items = node.map((item, i) => this.expand(item, [...path, i], chain, fromContent));
      return !fromContent && sameItems(node, items) ? node : items;
    }
    if (!isPlainObject(node)) return node;
    const type = node.__resolveType;
    if (typeof type === "string" && this.#functionFor(type) === undefined) {
      const saved = this.entry(type);
      if (saved !== undefined) {
        const next = [...chain, type];
        if (chain.includes(type)) throw errors.cycle(next);
        return this.expand(mergeReference(saved, node), path, next, true);
      }
    }
    let changed = fromContent;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      const expanded = this.expand(value, [...path, key], chain, fromContent);
      if (expanded !== value) changed = true;
      out[key] = expanded;
    }
    return changed ? out : node;
  }

  async #resolveFields(
    node: JsonObject,
    path: Path,
    chain: string[],
    fromContent: boolean,
  ): Promise<JsonObject> {
    const keys = Object.keys(node);
    const values = await Promise.all(
      keys.map((key) => this.resolve(node[key], [...path, key], chain, fromContent)),
    );
    let changed = fromContent;
    const out: JsonObject = {};
    keys.forEach((key, i) => {
      if (values[i] !== node[key]) changed = true;
      out[key] = values[i];
    });
    return changed ? out : node;
  }

  #resolveBlock(
    node: JsonObject,
    type: string,
    path: Path,
    chain: string[],
    fromContent: boolean,
    viaAlias = false,
  ): Promise<unknown> {
    const fn = this.#functionFor(type);
    if (fn !== undefined) {
      if (isLazyBuiltin(fn)) {
        return Promise.resolve(this.#lazy(node.value, [...path, "value"], chain, fromContent));
      }
      return this.#run(fn, type, node, path, chain);
    }

    const saved = this.entry(type);
    if (saved !== undefined) {
      const next = [...chain, type];
      if (chain.includes(type)) return Promise.reject(errors.cycle(next));
      if (RESERVED_NAMES.has(type)) this.#onCollision?.(type);
      return this.resolve(mergeReference(saved, node), path, next, true);
    }

    const alias = viaAlias ? undefined : own(this.#snapshot.aliases, type);
    if (alias !== undefined && alias !== type) {
      return this.#resolveBlock(node, alias, path, chain, fromContent, true);
    }
    return Promise.reject(errors.unknownBlock(type, path));
  }

  /** Block map first, then built-ins; a saved block of the same name loses (with a warning). */
  #functionFor(type: string): BlockFunction | undefined {
    const fn = own(this.#blocks, type) ?? own(builtIns, type);
    if (typeof fn !== "function") return undefined;
    if (this.entry(type) !== undefined) this.#onCollision?.(type);
    return fn;
  }

  #run(
    fn: BlockFunction,
    type: string,
    node: JsonObject,
    path: Path,
    chain: string[],
  ): Promise<unknown> {
    const key = canonicalKey(node, this.#keys);
    let results = this.#memo.get(fn);
    const hit = key === null ? undefined : results?.get(key);
    if (hit !== undefined) return hit;

    const pending = this.#call(fn, type, node, path, chain);
    if (key !== null) {
      if (results === undefined) {
        results = new Map();
        this.#memo.set(fn, results);
      }
      results.set(key, pending);
    }
    return pending;
  }

  async #call(
    fn: BlockFunction,
    type: string,
    node: JsonObject,
    path: Path,
    chain: string[],
  ): Promise<unknown> {
    // Inputs are always fresh objects: a function may mutate its props freely.
    const { __resolveType: _type, ...inputs } = node;
    const resolved = await this.#resolveFields(inputs, path, chain, true);
    try {
      return await fn(resolved);
    } catch (error) {
      // A lazy block's failure escaping its caller keeps its own code and path.
      if (isResolutionError(error)) throw error;
      throw errors.blockFailed(type, path, error);
    }
  }

  #lazy(value: unknown, path: Path, chain: string[], fromContent: boolean): Lazy<unknown> {
    let pending: Promise<unknown> | undefined;
    return () => {
      pending ??= this.resolve(value, path, chain, fromContent);
      return pending;
    };
  }
}

/** `{ ...saved, ...arguments }`: shallow, and the saved block's type wins. */
function mergeReference(saved: unknown, reference: JsonObject): unknown {
  if (!isPlainObject(saved)) return saved;
  const { __resolveType: _ref, ...overrides } = reference;
  const merged: JsonObject = { ...saved, ...overrides };
  if ("__resolveType" in saved) merged.__resolveType = saved.__resolveType;
  else delete merged.__resolveType;
  return merged;
}

function sameItems(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
